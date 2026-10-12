import type { FillRequest, FillResult, FillTraceStep } from '../../../domain/types'
import type { FieldRef } from '../scan/collector'
import { normalize } from '../../../shared/normalize'
import { isPlaceholderOption, optionEquivalent } from '../../ontology/optionMatch'
import { expandCandidates } from '../../ontology/synonyms'
import { normalizeDateValue } from '../../ontology/validators'
import { readCurrentValue } from '../scan/collector'
import { isElementVisible, pollUntil, wait } from './domUtils'
import { resolveRecognizer, splitCascadeValue, type ControlRecognizer } from './recognizers'
import { compareProjectedSequence, projectOptionFromValue } from '../valueProjection'

/**
 * 写入-回读-重试状态机（F14，TECH_DESIGN §9）。
 *
 * LOCATE → PRECHECK → SNAPSHOT → APPLY → SETTLE（轮询回读）→ VERIFY → OK / RETRY / FAIL
 *
 * 替换旧的「写入后固定 wait(80) 回读一次」：慢渲染站点不再被误判失败，
 * 失败携带机器可读 reasonCode 并按原因分类重试。
 */

const DEFAULT_SETTLE_TIMEOUT = 2000
const MAX_SYNONYM_RETRIES = 3
const MAX_REOPEN_RETRIES = 2
const MAX_CANDIDATES = 6

/** 本站记过的写法在前，档案原值其次，同义值表最后。 */
export function fillCandidates(request: FillRequest): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  const push = (value: string) => {
    const text = value.trim()
    if (!text || seen.has(text)) return
    seen.add(text)
    ordered.push(text)
  }
  for (const value of request.priorValues || []) push(value)
  push(request.value)
  for (const value of expandCandidates(request.value).slice(0, MAX_SYNONYM_RETRIES)) push(value)
  return ordered.slice(0, MAX_CANDIDATES)
}

export interface UndoRecord {
  fieldId: string
  ref: FieldRef
  recognizerId: string
  previous: string
  checked?: boolean[]
  outline: string
  outlineOffset: string
  title: string
}

export interface FillExecution {
  result: FillResult
  undo?: UndoRecord
}

/** DOM 写入失败后的可选恢复通道（例如截图 OCR + 真实坐标点击）。 */
export type FillRecovery = (
  request: FillRequest,
  failed: FillExecution,
  ref: FieldRef | undefined
) => Promise<FillExecution | undefined>

export interface FillSequenceHooks {
  after?(request: FillRequest, execution: FillExecution, ref: FieldRef | undefined): void | Promise<void>
}

/** kind 感知的一致性判定（VERIFY）。 */
export function valuesEquivalent(ref: FieldRef, actual: string, expected: string): boolean {
  const kind = ref.kind
  if (kind === 'date') {
    const expectedClock = expected.trim().match(/^(\d{1,2}):(\d{2})/)
    const actualClock = actual.trim().match(/^(\d{1,2}):(\d{2})/)
    if (expectedClock && actualClock && !/\d{4}/.test(expected)) {
      return expectedClock[1].padStart(2, '0') === actualClock[1].padStart(2, '0') && expectedClock[2] === actualClock[2]
    }
    const monthOnly = !/\d{4}\D\d{1,2}\D\d{1,2}/.test(actual)
    const expectedNorm = normalizeDateValue(expected, monthOnly)
    const actualNorm = normalizeDateValue(actual, monthOnly)
    return actualNorm === expectedNorm
  }
  if (['select', 'radio', 'combobox', 'cascade'].includes(kind)) {
    const parts = kind === 'radio' ? [] : splitCascadeValue(expected)
    if (parts.length > 1) {
      const actualParts = splitCascadeValue(actual)
      return parts.every(part => actualParts.some(item => optionEquivalent(item, part)) || optionEquivalent(actual, part))
    }
    if (kind === 'cascade' && compareProjectedSequence(expected, actual) !== 'different') return true
    return optionEquivalent(actual, expected)
  }
  if (['multiselect', 'checkbox'].includes(kind)) {
    const requested = expected.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
    const actualParts = actual.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
    if (requested.length <= 1) return optionEquivalent(actual, expected)
    return requested.every(item => actualParts.some(part => optionEquivalent(part, item)))
  }
  const digits = (text: string) => text.replace(/\D/g, '')
  const actualDigits = digits(actual)
  const expectedDigits = digits(expected)
  if (actualDigits.length >= 11 && actualDigits === expectedDigits) return true
  return normalize(actual) === normalize(expected)
}

/** 只认当前表单项上、用户看得到的校验文案。类名里带 error 的图标不能当成拒绝。 */
function hasValidationError(ref: FieldRef): boolean {
  const element = ref.element
  if (element.getAttribute('aria-invalid') === 'true') return true
  const container = element.closest('.ant-form-item,.el-form-item,.arco-form-item,.form-group')
  if (!container) return false
  const errorNode = container.querySelector<HTMLElement>('.ant-form-item-explain-error,.el-form-item__error,.arco-form-item-message,.invalid-feedback')
  return Boolean(errorNode && isElementVisible(errorNode) && errorNode.textContent?.trim())
}

interface SettleOutcome {
  status: 'ok' | 'validation-error' | 'cleared' | 'timeout'
  actual: string
}

/** SETTLE：轮询回读（间隔 30/60/120/240/480ms 递增）。 */
async function settle(ref: FieldRef, recognizer: ControlRecognizer, expected: string, timeoutMs: number): Promise<SettleOutcome> {
  let everMatched = false
  const outcome = await pollUntil<SettleOutcome | null>(() => {
    if (!ref.element.isConnected) return { status: 'cleared', actual: '' }
    const actual = recognizer.read({ ref })
    if (valuesEquivalent(ref, actual, expected)) {
      everMatched = true
      return { status: 'ok', actual }
    }
    if (everMatched && !actual.trim()) return { status: 'cleared', actual }
    return null
  }, timeoutMs)
  if (outcome) return outcome
  const actual = ref.element.isConnected ? recognizer.read({ ref }) : ''
  if (hasValidationError(ref) && !valuesEquivalent(ref, actual, expected)) {
    return { status: 'validation-error', actual }
  }
  return { status: everMatched ? 'cleared' : 'timeout', actual }
}

function fail(request: FillRequest, reasonCode: NonNullable<FillResult['reasonCode']>, message: string, attempts: number, startedAt: number, trace: FillTraceStep[] = []): FillExecution {
  return {
    result: {
      fieldId: request.fieldId, status: 'failed', message, value: request.value,
      source: request.source, confidence: request.confidence,
      reasonCode, attempts, elapsedMs: Date.now() - startedAt, trace
    }
  }
}

/**
 * 执行单字段填写。
 * @param locate 按指纹定位控件；ref 失效时由调用方重扫后再次定位（禁止用位置 ID 猜测）。
 */
export async function executeFill(request: FillRequest, locate: () => FieldRef | undefined): Promise<FillExecution> {
  const startedAt = Date.now()
  let attempts = 0
  const trace: FillTraceStep[] = []
  const note = (stage: FillTraceStep['stage'], status: FillTraceStep['status'], detail?: string, strategy?: string) => {
    trace.push({ stage, status, detail, strategy, elapsedMs: Date.now() - startedAt })
  }

  // LOCATE
  let ref = locate()
  if (!ref || !ref.element.isConnected) {
    note('locate', 'failed', '元素不存在或已断开')
    return fail(request, 'element-lost', '页面上找不到该字段（可能已重渲染），请重新识别', attempts, startedAt, trace)
  }
  note('locate', 'ok', ref.kind)
  if (ref.kind === 'file') {
    note('precheck', 'failed', '文件上传不自动执行')
    return fail(request, 'unsupported-control', '附件需要你在网页上手动选择，插件不会代为上传', attempts, startedAt, trace)
  }
  const recognizer = resolveRecognizer(ref)
  if (!recognizer) {
    note('precheck', 'failed', '没有可用交互策略')
    return fail(request, 'unsupported-control', '暂不支持该控件类型', attempts, startedAt, trace)
  }
  note('precheck', 'ok', ref.kind, recognizer.id)

  // PRECHECK
  const element = ref.element
  const customControl = ref.kind === 'combobox' || ref.kind === 'cascade' || ref.kind === 'date'
  if ((element as HTMLInputElement).disabled || (!customControl && (element as HTMLInputElement).readOnly)) {
    note('precheck', 'failed', '只读或禁用', recognizer.id)
    return fail(request, 'readonly', '字段为只读或禁用状态', attempts, startedAt, trace)
  }
  const previous = readCurrentValue(ref)
  // 自动填写永远以页面现值为准。即使扫描时字段还是空的，只要用户在真正
  // 写入前已经填过，也在这里实时回读并跳过。只有明确的手动操作可以覆盖。
  if (previous.trim() && request.intent !== 'manual') {
    note('precheck', 'skipped', '页面已有内容', recognizer.id)
    return {
      result: {
        fieldId: request.fieldId, status: 'skipped', message: '页面已有内容，保留原值',
        value: previous, source: request.source, confidence: request.confidence,
        reasonCode: 'skipped-existing', attempts, elapsedMs: Date.now() - startedAt, trace
      }
    }
  }

  // SNAPSHOT（供撤销）
  const undo: UndoRecord = {
    fieldId: request.fieldId,
    ref,
    recognizerId: recognizer.id,
    previous,
    checked: (ref.radios || ref.checkboxes)?.map(input => input.checked),
    outline: element.style.outline,
    outlineOffset: element.style.outlineOffset,
    title: element.getAttribute('title') || ''
  }

  // APPLY + SETTLE + RETRY
  const candidates = fillCandidates(request)
  let reopenBudget = MAX_REOPEN_RETRIES
  let rerenderBudget = 1
  const trustedAvailable = Boolean(recognizer.trustedWrite && ref.control?.capabilities.canTrustedInput !== false)
  let preferredTrustedBudget = trustedAvailable && request.preferredStrategy === `trusted:${recognizer.id}` ? 1 : 0
  let trustedBudget = trustedAvailable && !preferredTrustedBudget ? 1 : 0
  let lastReason: NonNullable<FillResult['reasonCode']> = 'timeout'
  let lastDetail = ''
  let lastStrategy = recognizer.id

  for (let candidateIndex = 0; candidateIndex < candidates.length;) {
    const sourceValue = candidates[candidateIndex]
    const select = ref.element instanceof HTMLSelectElement ? ref.element : null
    const projected = request.valueMode === 'match-options' && select
      ? projectOptionFromValue(Array.from(select.options).map(option => option.text), sourceValue)
      : null
    const value = projected && !projected.ambiguous ? projected.value : sourceValue
    attempts += 1
    const usePreferredTrusted = preferredTrustedBudget > 0 && Boolean(recognizer.trustedWrite)
    if (usePreferredTrusted) preferredTrustedBudget -= 1
    const attemptStrategy = usePreferredTrusted ? `trusted:${recognizer.id}` : recognizer.id
    lastStrategy = attemptStrategy
    const attempt = usePreferredTrusted
      ? await recognizer.trustedWrite!({ ref, request }, value)
      : await recognizer.write({ ref, request }, value)

    if (!attempt.applied) {
      lastReason = attempt.reasonCode || 'no-matching-option'
      lastDetail = attempt.detail || ''
      // 轨迹只记录失败类别，不复制候选值或页面回读正文，避免诊断信息携带隐私。
      note('apply', 'failed', lastReason, attemptStrategy)
      if (usePreferredTrusted) {
        note('apply', 'retry', '历史优选策略失败，回退标准交互', recognizer.id)
        continue
      }
      if (lastReason === 'option-list-not-found' && reopenBudget > 0) {
        // 点击空白收起后重新展开
        reopenBudget -= 1
        document.body.click()
        await wait(200)
        note('apply', 'retry', '重新展开选项浮层', recognizer.id)
        continue
      }
      if (lastReason === 'no-matching-option' && candidateIndex + 1 < candidates.length) {
        candidateIndex += 1 // 取同义值表的下一个候选重试
        note('apply', 'retry', '尝试下一个同义值', recognizer.id)
        continue
      }
      break
    }
    note('apply', attempts > 1 ? 'retry' : 'ok', `第 ${attempts} 次写入已执行`, attemptStrategy)

    let settled = await settle(ref, recognizer, value, recognizer.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT)
    note('settle', settled.status === 'ok' ? 'ok' : 'failed', settled.actual ? '页面已返回非空值' : settled.status, attemptStrategy)
    const shouldTryTrusted = settled.status === 'timeout' || (settled.status === 'cleared' && rerenderBudget === 0)
    if (shouldTryTrusted && trustedBudget > 0 && recognizer.trustedWrite) {
      trustedBudget -= 1
      attempts += 1
      lastStrategy = `trusted:${recognizer.id}`
      note('apply', 'retry', '普通 DOM 交互未通过回读，切换可信输入', `trusted:${recognizer.id}`)
      const trusted = await recognizer.trustedWrite({ ref, request }, value)
      if (trusted.applied) {
        settled = await settle(ref, recognizer, value, recognizer.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT)
        note('settle', settled.status === 'ok' ? 'ok' : 'failed', settled.status === 'ok' ? '可信输入通过回读' : 'trusted-input-failed', `trusted:${recognizer.id}`)
      } else {
        lastReason = 'trusted-input-failed'
        note('apply', 'failed', 'trusted-input-failed', `trusted:${recognizer.id}`)
      }
    }
    if (settled.status === 'ok') {
      note('verify', 'ok', '页面回读一致', lastStrategy)
      return {
        result: {
          fieldId: request.fieldId, status: 'filled', message: '已填写并回读确认',
          value, source: request.source, confidence: request.confidence,
          reasonCode: 'ok', attempts, elapsedMs: Date.now() - startedAt, trace
        },
        undo
      }
    }
    if (settled.status === 'validation-error') {
      note('verify', 'failed', '页面校验拒绝', recognizer.id)
      return fail(request, 'rejected-by-validation', `页面校验拒绝了该值（回读：${settled.actual || '空'}）`, attempts, startedAt, trace)
    }
    if (settled.status === 'cleared' && rerenderBudget > 0) {
      // 按指纹重新定位后重写一次
      rerenderBudget -= 1
      const relocated = locate()
      if (relocated?.element.isConnected) {
        ref = relocated
        note('locate', 'retry', '重渲染后已按指纹重新定位', recognizer.id)
        continue
      }
      note('locate', 'failed', '重渲染后无法重新定位', recognizer.id)
      return fail(request, 'cleared-by-rerender', '填写后被页面重渲染清空，且字段无法重新定位', attempts, startedAt, trace)
    }
    lastReason = settled.status === 'cleared' ? 'cleared-by-rerender' : 'timeout'
    if (!trustedBudget && recognizer.trustedWrite) lastReason = 'trusted-input-failed'
    lastDetail = `回读值：${settled.actual || '空'}`
    break
  }

  const messages: Record<string, string> = {
    'no-matching-option': `选项集中没有可匹配的值${lastDetail ? `（${lastDetail}）` : ''}`,
    'option-list-not-found': `无法定位该控件的选项浮层${lastDetail ? `（${lastDetail}）` : ''}`,
    'cleared-by-rerender': '填写结果被页面重渲染清空',
    'rejected-by-validation': '页面校验拒绝了该值',
    'unsupported-control': '暂不支持该控件类型',
    'trusted-input-failed': '普通 DOM 写入和浏览器可信输入均未通过页面回读',
    timeout: `网页未保留填写结果${lastDetail ? `（${lastDetail}）` : ''}`
  }
  note('verify', 'failed', lastReason, lastStrategy)
  return fail(request, lastReason, messages[lastReason] || '填写失败', attempts, startedAt, trace)
}

/** 原生下拉还只有占位项时，先写别的字段，等选项出来再写它。 */
export function selectWaitingForOptions(element: HTMLElement): boolean {
  if (!(element instanceof HTMLSelectElement) || element.multiple) return false
  return !Array.from(element.options).some(option => {
    const text = option.text.trim()
    return Boolean(text) && !option.disabled && !isPlaceholderOption(text)
  })
}

function optionsNotReady(result: FillResult): boolean {
  return result.reasonCode === 'option-list-not-found' && (result.message || '').includes('选项尚未出现')
}

/**
 * 自定义选择器最容易受异步浮层、动画和站点脚本影响，放到批次末尾。
 * 这样单个下拉即使耗尽重试，也不会阻塞文本、日期、原生选择等稳定字段。
 */
function fillPriority(ref: FieldRef | undefined): number {
  if (!ref) return 1
  if (ref.kind === 'combobox' || ref.kind === 'cascade' || ref.kind === 'multiselect' && !(ref.element instanceof HTMLSelectElement)) return 2
  return 0
}

/** 先按稳定控件优先级排序，再用已确认的父子边做稳定拓扑调整。 */
function orderFillRequests(values: FillRequest[], locate: (fieldId: string) => FieldRef | undefined): FillRequest[] {
  const base = values
    .map((request, index) => ({ request, index, priority: fillPriority(locate(request.fieldId)) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(item => item.request)
  const byId = new Map(base.map(request => [request.fieldId, request] as const))
  const children = new Map<string, string[]>()
  const indegree = new Map<string, number>(base.map(request => [request.fieldId, 0]))
  for (const request of base) {
    for (const parent of new Set(request.dependsOn || [])) {
      if (!byId.has(parent) || parent === request.fieldId) continue
      const rows = children.get(parent) || []
      rows.push(request.fieldId)
      children.set(parent, rows)
      indegree.set(request.fieldId, (indegree.get(request.fieldId) || 0) + 1)
    }
  }
  const pending = base.filter(request => indegree.get(request.fieldId) === 0)
  const ordered: FillRequest[] = []
  while (pending.length) {
    const request = pending.shift()!
    ordered.push(request)
    for (const child of children.get(request.fieldId) || []) {
      const next = (indegree.get(child) || 0) - 1
      indegree.set(child, next)
      if (next === 0) pending.push(byId.get(child)!)
    }
  }
  // 冲突或环不得猜测；剩余节点按原定稳定顺序追加。
  const emitted = new Set(ordered.map(request => request.fieldId))
  return [...ordered, ...base.filter(request => !emitted.has(request.fieldId))]
}

/**
 * 已有真实选项的字段先写。选项仍是占位符的先跳过，写完其它字段后再试一次。
 * 不按省市区或其它标签排序。
 */
export async function executeFillSequence(
  values: FillRequest[],
  locate: (fieldId: string) => FieldRef | undefined,
  recover?: FillRecovery,
  hooks?: FillSequenceHooks
): Promise<FillExecution[]> {
  const done: FillExecution[] = []
  const later: FillRequest[] = []
  const recoverIfNeeded = async (request: FillRequest, execution: FillExecution): Promise<FillExecution> => {
    if (!recover || execution.result.status !== 'failed') return execution
    if (execution.result.reasonCode !== 'option-list-not-found' && execution.result.reasonCode !== 'no-matching-option') return execution
    return await recover(request, execution, locate(request.fieldId)).catch(() => undefined) || execution
  }
  const finish = async (request: FillRequest, execution: FillExecution): Promise<FillExecution> => {
    const recovered = await recoverIfNeeded(request, execution)
    await hooks?.after?.(request, recovered, locate(request.fieldId))
    return recovered
  }
  const ordered = orderFillRequests(values, locate)
  for (const request of ordered) {
    const ref = locate(request.fieldId)
    if (ref && selectWaitingForOptions(ref.element)) {
      later.push(request)
      continue
    }
    const execution = await executeFill(request, () => locate(request.fieldId))
    if (optionsNotReady(execution.result)) later.push(request)
    else done.push(await finish(request, execution))
  }
  for (const request of later) {
    const ref = locate(request.fieldId)
    if (ref?.element instanceof HTMLSelectElement) await pollUntil(() => !selectWaitingForOptions(ref.element), 1500)
    const execution = await executeFill(request, () => locate(request.fieldId))
    done.push(await finish(request, execution))
  }
  return done
}

/** 撤销单条记录（F52）。返回 null 表示成功，否则返回无法恢复的原因。 */
export async function undoRecord(record: UndoRecord): Promise<string | null> {
  const { ref, previous, checked } = record
  if (!ref.element.isConnected) return '控件已从页面移除'
  if ((ref.kind === 'radio' || ref.kind === 'checkbox') && checked) {
    const inputs = ref.radios || ref.checkboxes || []
    inputs.forEach((input, index) => {
      if (input.checked !== checked[index]) input.click()
    })
    return null
  }
  const recognizer = resolveRecognizer(ref)
  if (recognizer?.restore) {
    const restored = await recognizer.restore({ ref }, previous)
    return restored ? null : '该控件不支持自动恢复，请手动检查'
  }
  return '该控件不支持自动恢复，请手动检查'
}
