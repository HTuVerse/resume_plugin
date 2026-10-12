import type { FillRequest } from '../../../domain/types'
import type { FieldRef } from '../scan/collector'
import { readCurrentValue } from '../scan/collector'
import { splitCascadeValue } from './recognizers'
import { fillCandidates, valuesEquivalent, type FillExecution, type FillRecovery, type UndoRecord } from './writeMachine'
import { pollUntil, wait } from './domUtils'

interface ViewRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface VisualResponse {
  available?: boolean
  ok?: boolean
  found?: boolean
  confidence?: number
  text?: string
  x?: number
  y?: number
  engine?: string
  error?: string
  ocrAvailable?: boolean
  aiAvailable?: boolean
  aiVerified?: boolean
  aiRejected?: boolean
  aiTestedAt?: string
}

export interface VisualWarmupState {
  ready: boolean
  ocrAvailable: boolean
  aiAvailable: boolean
  aiVerified: boolean
  aiRejected: boolean
  aiTestedAt?: string
  error?: string
}

const CLICKABLE = '.ant-select-selector,.el-select__wrapper,.el-input__wrapper,.el-input,.arco-select-view,.n-base-selection,.ivu-select-selection,.semi-select-selection,.t-select__wrap,.t-input__wrap'
const MIN_OPTION_CONFIDENCE = 0.66
const MIN_VERIFY_CONFIDENCE = 0.72

function plainRect(rect: DOMRect): ViewRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  }
}

function center(rect: ViewRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function pointInside(rect: ViewRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function searchRegion(rect: ViewRect): ViewRect {
  const left = Math.max(0, rect.left - 280)
  const top = Math.max(0, rect.top - 360)
  const right = Math.min(window.innerWidth, rect.right + 420)
  const bottom = Math.min(window.innerHeight, rect.bottom + 440)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function verifyRegion(rect: ViewRect): ViewRect {
  const left = Math.max(0, rect.left - 12)
  const top = Math.max(0, rect.top - 8)
  const right = Math.min(window.innerWidth, rect.right + 12)
  const bottom = Math.min(window.innerHeight, rect.bottom + 8)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

async function afterPaint(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/** 截图时临时隐藏助手面板，避免面板盖住页面选项；完成后原样恢复。 */
async function withoutAssistantOverlay<T>(run: () => Promise<T>): Promise<T> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-resume-assistant]'))
  const visibility = nodes.map(node => node.style.visibility)
  nodes.forEach(node => { node.style.visibility = 'hidden' })
  try {
    await afterPaint()
    return await run()
  } finally {
    nodes.forEach((node, index) => { node.style.visibility = visibility[index] })
  }
}

async function runtimeMessage(message: object): Promise<VisualResponse> {
  return chrome.runtime.sendMessage(message).catch(error => ({ available: false, error: String(error) })) as Promise<VisualResponse>
}

export async function warmupVisualAssist(): Promise<VisualWarmupState> {
  const response = await runtimeMessage({ type: 'VISUAL_WARMUP' })
  return {
    ready: response.ocrAvailable === true && response.ok !== false,
    ocrAvailable: response.ocrAvailable === true,
    aiAvailable: response.aiAvailable === true,
    aiVerified: response.aiVerified === true,
    aiRejected: response.aiRejected === true,
    aiTestedAt: response.aiTestedAt,
    error: response.error
  }
}

async function realClick(x: number, y: number): Promise<boolean> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  const response = await withoutAssistantOverlay(() => runtimeMessage({ type: 'VISUAL_REAL_CLICK', x, y }))
  return response.ok === true
}

async function locateText(targets: string[], trigger: ViewRect, region: ViewRect, mode: 'option' | 'verify'): Promise<VisualResponse> {
  return withoutAssistantOverlay(() => runtimeMessage({
    type: 'VISUAL_LOCATE_TEXT',
    targets,
    mode,
    trigger,
    region,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 }
  }))
}

function visualTargets(request: FillRequest, ref: FieldRef): string[] {
  if (ref.kind === 'cascade') return splitCascadeValue(request.value)
  if (ref.kind === 'multiselect') return request.value.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
  return [request.value]
}

function undoFor(request: FillRequest, ref: FieldRef, previous: string): UndoRecord {
  return {
    fieldId: request.fieldId,
    ref,
    recognizerId: 'visual-coordinate',
    previous,
    checked: (ref.radios || ref.checkboxes)?.map(input => input.checked),
    outline: ref.element.style.outline,
    outlineOffset: ref.element.style.outlineOffset,
    title: ref.element.getAttribute('title') || ''
  }
}

async function clickVisualOption(targets: string[], triggerRect: ViewRect, allowAlreadyOpen: boolean): Promise<VisualResponse | null> {
  if (allowAlreadyOpen) {
    const visible = await locateText(targets, triggerRect, searchRegion(triggerRect), 'option')
    if (visible.found && (visible.confidence || 0) >= 0.84 && visible.x != null && visible.y != null
      && !pointInside(triggerRect, visible.x, visible.y) && await realClick(visible.x, visible.y)) {
      return visible
    }
  }
  return null
}

interface VisualAttempt {
  execution?: FillExecution
  error?: string
}

function appendVisualTrace(failed: FillExecution, status: 'ok' | 'failed' | 'skipped', detail: string, recoveryStarted: number) {
  return [
    ...(failed.result.trace || []),
    {
      stage: 'visual' as const,
      status,
      strategy: 'ocr+vision-ai',
      detail,
      elapsedMs: (failed.result.elapsedMs || 0) + Math.max(0, Date.now() - recoveryStarted)
    }
  ]
}

function elapsedWithVisualRecovery(failed: FillExecution, recoveryStarted: number): number {
  return (failed.result.elapsedMs || 0) + Math.max(0, Date.now() - recoveryStarted)
}

async function visualFill(request: FillRequest, failed: FillExecution, ref: FieldRef, recoveryStarted: number): Promise<VisualAttempt> {
  if (!['combobox', 'cascade', 'multiselect'].includes(ref.kind) || ref.element instanceof HTMLSelectElement) return {}
  if (!ref.element.isConnected) return {}

  ref.element.scrollIntoView({ block: 'center', inline: 'nearest' })
  await wait(180)
  const clickable = ref.element.querySelector<HTMLElement>(CLICKABLE) || ref.element
  let triggerRect = plainRect(clickable.getBoundingClientRect())
  if (triggerRect.width < 2 || triggerRect.height < 2) return { error: '控件当前不可见，无法截图识别' }
  const previous = readCurrentValue(ref)
  const levels = visualTargets(request, ref)
  if (!levels.length) return { error: '没有可供视觉识别的目标值' }
  let visualConfidence = 1

  // DOM 重试可能把一个未知浮层留在页面上，先从当前画面查找，避免再点触发器把它关掉。
  const initialTargets = levels.length === 1 ? fillCandidates(request) : [levels[0]]
  const existing = await clickVisualOption(initialTargets, triggerRect, true)
  if (existing) {
    visualConfidence = Math.min(visualConfidence, existing.confidence || 0)
  } else {
    const triggerPoint = center(triggerRect)
    if (!await realClick(triggerPoint.x, triggerPoint.y)) return { error: '无法对下拉控件发出真实点击' }
    await wait(280)
  }

  for (let index = existing ? 1 : 0; index < levels.length; index += 1) {
    triggerRect = plainRect(clickable.getBoundingClientRect())
    const target = levels[index]
    const candidates = index === 0 ? fillCandidates({ ...request, value: target }) : [target]
    const located = await locateText(candidates, triggerRect, searchRegion(triggerRect), 'option')
    if (!located.found || (located.confidence || 0) < MIN_OPTION_CONFIDENCE || located.x == null || located.y == null) {
      return { error: located.error || '本地 OCR 与视觉 AI 未找到一致的高置信选项' }
    }
    if (pointInside(triggerRect, located.x, located.y)) return { error: '视觉候选坐标落在触发器内部，已拒绝点击' }
    if (!await realClick(located.x, located.y)) return { error: '无法对视觉候选发出真实点击' }
    visualConfidence = Math.min(visualConfidence, located.confidence || 0)
    await wait(index === levels.length - 1 ? 260 : 360)
  }

  const expected = request.value
  const verified = await pollUntil(() => {
    const actual = readCurrentValue(ref)
    return valuesEquivalent(ref, actual, expected) ? actual : null
  }, 1600)
  if (!verified) {
    const visual = await locateText(fillCandidates(request), plainRect(clickable.getBoundingClientRect()), verifyRegion(plainRect(clickable.getBoundingClientRect())), 'verify')
    if (!visual.found || (visual.confidence || 0) < MIN_VERIFY_CONFIDENCE) return { error: visual.error || '视觉复核未确认回填结果' }
    visualConfidence = Math.min(visualConfidence, visual.confidence || 0)
  }

  return {
    execution: {
      result: {
        ...failed.result,
        status: 'filled',
        reasonCode: 'ok',
        message: verified ? '已通过视觉点击并回读确认' : '已通过视觉点击并截图确认，请核对高亮字段',
        value: request.value,
        confidence: Math.min(request.confidence ?? 1, visualConfidence),
        attempts: (failed.result.attempts || 0) + 1,
        elapsedMs: elapsedWithVisualRecovery(failed, recoveryStarted),
        trace: appendVisualTrace(failed, 'ok', verified ? '视觉点击并通过页面回读' : '视觉点击并通过局部截图确认', recoveryStarted)
      },
      undo: undoFor(request, ref, previous)
    }
  }
}

/**
 * 批量开始时立即调用。本地 OCR 在普通字段填写期间并行加载，只有 DOM 下拉失败时才等待它；
 * 坐标点击还必须通过已配置视觉 AI 的独立复核。
 */
export function createVisualRecovery(): FillRecovery {
  const ready = warmupVisualAssist()
  return async (request, failed, ref) => {
    const recoveryStarted = Date.now()
    const eligible = Boolean(ref && ['combobox', 'cascade', 'multiselect'].includes(ref.kind) && !(ref.element instanceof HTMLSelectElement))
    if (!ref || !eligible) return undefined
    const state = await ready
    if (!state.ready) {
      return {
        ...failed,
        result: {
          ...failed.result,
          message: `${failed.result.message}；浏览器内本地 OCR 未能启动${state.error ? `（${state.error}）` : ''}`,
          elapsedMs: elapsedWithVisualRecovery(failed, recoveryStarted),
          trace: appendVisualTrace(failed, 'failed', '本地 OCR 未就绪', recoveryStarted)
        }
      }
    }
    if (!state.aiAvailable) {
      return {
        ...failed,
        result: {
          ...failed.result,
          message: `${failed.result.message}；本地 OCR 已就绪，但尚未配置支持图片输入的视觉 AI`,
          elapsedMs: elapsedWithVisualRecovery(failed, recoveryStarted),
          trace: appendVisualTrace(failed, 'skipped', '视觉模型未配置', recoveryStarted)
        }
      }
    }
    const attempt = await visualFill(request, failed, ref, recoveryStarted)
    if (attempt.execution) return attempt.execution
    return {
      ...failed,
      result: {
        ...failed.result,
        message: `${failed.result.message}；${attempt.error || '本地 OCR 与视觉 AI 未达成可安全点击的一致结果'}`,
        elapsedMs: elapsedWithVisualRecovery(failed, recoveryStarted),
        trace: appendVisualTrace(failed, 'failed', attempt.error || 'OCR 与视觉模型未达成一致', recoveryStarted)
      }
    }
  }
}
