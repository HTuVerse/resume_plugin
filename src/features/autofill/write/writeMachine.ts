import type { FillRequest, FillResult } from '../../../domain/types'
import type { FieldRef } from '../scan/collector'
import { normalize } from '../../../shared/normalize'
import { optionEquivalent } from '../../ontology/optionMatch'
import { expandCandidates } from '../../ontology/synonyms'
import { normalizeDateValue } from '../../ontology/validators'
import { readCurrentValue } from '../scan/collector'
import { isElementVisible, pollUntil, wait } from './domUtils'
import { resolveRecognizer, type ControlRecognizer } from './recognizers'

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
  if (['select', 'radio', 'combobox'].includes(kind)) return optionEquivalent(actual, expected)
  if (kind === 'cascade') {
    // 级联回读值是多级拼接（如「广东省 / 广州市」），要求每级候选都出现在回读值里
    const actualNorm = normalize(actual)
    const parts = expected.split(/\s*[\/>»→\-—、,，]\s*/).filter(Boolean)
    return parts.length > 0 && parts.every(part => actualNorm.includes(normalize(part)))
  }
  if (['multiselect', 'checkbox'].includes(kind)) {
    const requested = expected.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
    const actualParts = actual.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
    if (requested.length <= 1) return optionEquivalent(actual, expected)
    return requested.every(item => actualParts.some(part => optionEquivalent(part, item)))
  }
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

function fail(request: FillRequest, reasonCode: NonNullable<FillResult['reasonCode']>, message: string, attempts: number, startedAt: number): FillExecution {
  return {
    result: {
      fieldId: request.fieldId, status: 'failed', message, value: request.value,
      source: request.source, confidence: request.confidence,
      reasonCode, attempts, elapsedMs: Date.now() - startedAt
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

  // LOCATE
  let ref = locate()
  if (!ref || !ref.element.isConnected) {
    return fail(request, 'element-lost', '页面上找不到该字段（可能已重渲染），请重新识别', attempts, startedAt)
  }
  const recognizer = resolveRecognizer(ref)
  if (!recognizer) {
    return fail(request, 'unsupported-control', '暂不支持该控件类型', attempts, startedAt)
  }

  // PRECHECK
  const element = ref.element
  const customControl = ref.kind === 'combobox' || ref.kind === 'cascade' || ref.kind === 'date'
  if ((element as HTMLInputElement).disabled || (!customControl && (element as HTMLInputElement).readOnly)) {
    return fail(request, 'readonly', '字段为只读或禁用状态', attempts, startedAt)
  }
  const previous = readCurrentValue(ref)
  if (previous.trim() && !request.overwrite) {
    return {
      result: {
        fieldId: request.fieldId, status: 'skipped', message: '页面已有内容，保留原值',
        value: previous, source: request.source, confidence: request.confidence,
        reasonCode: 'skipped-existing', attempts, elapsedMs: Date.now() - startedAt
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
  const candidates = [request.value, ...expandCandidates(request.value).slice(0, MAX_SYNONYM_RETRIES)]
  let reopenBudget = MAX_REOPEN_RETRIES
  let rerenderBudget = 1
  let lastReason: NonNullable<FillResult['reasonCode']> = 'timeout'
  let lastDetail = ''

  for (let candidateIndex = 0; candidateIndex < candidates.length;) {
    const value = candidates[candidateIndex]
    attempts += 1
    const attempt = await recognizer.write({ ref }, value)

    if (!attempt.applied) {
      lastReason = attempt.reasonCode || 'no-matching-option'
      lastDetail = attempt.detail || ''
      if (lastReason === 'option-list-not-found' && reopenBudget > 0) {
        // 点击空白收起后重新展开
        reopenBudget -= 1
        document.body.click()
        await wait(200)
        continue
      }
      if (lastReason === 'no-matching-option' && candidateIndex + 1 < candidates.length) {
        candidateIndex += 1 // 取同义值表的下一个候选重试
        continue
      }
      break
    }

    const settled = await settle(ref, recognizer, value, recognizer.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT)
    if (settled.status === 'ok') {
      return {
        result: {
          fieldId: request.fieldId, status: 'filled', message: '已填写并回读确认',
          value, source: request.source, confidence: request.confidence,
          reasonCode: 'ok', attempts, elapsedMs: Date.now() - startedAt
        },
        undo
      }
    }
    if (settled.status === 'validation-error') {
      return fail(request, 'rejected-by-validation', `页面校验拒绝了该值（回读：${settled.actual || '空'}）`, attempts, startedAt)
    }
    if (settled.status === 'cleared' && rerenderBudget > 0) {
      // 按指纹重新定位后重写一次
      rerenderBudget -= 1
      const relocated = locate()
      if (relocated?.element.isConnected) {
        ref = relocated
        continue
      }
      return fail(request, 'cleared-by-rerender', '填写后被页面重渲染清空，且字段无法重新定位', attempts, startedAt)
    }
    lastReason = settled.status === 'cleared' ? 'cleared-by-rerender' : 'timeout'
    lastDetail = `回读值：${settled.actual || '空'}`
    break
  }

  const messages: Record<string, string> = {
    'no-matching-option': `选项集中没有可匹配的值${lastDetail ? `（${lastDetail}）` : ''}`,
    'option-list-not-found': '无法定位该控件的选项浮层',
    'cleared-by-rerender': '填写结果被页面重渲染清空',
    'rejected-by-validation': '页面校验拒绝了该值',
    'unsupported-control': '暂不支持该控件类型',
    timeout: `网页未保留填写结果${lastDetail ? `（${lastDetail}）` : ''}`
  }
  return fail(request, lastReason, messages[lastReason] || '填写失败', attempts, startedAt)
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
