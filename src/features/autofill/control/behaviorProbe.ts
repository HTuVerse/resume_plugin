import { isElementVisible, wait } from '../write/domUtils'
import { popupOptions, watchForPopup } from '../write/popupLocator'
import type { OptionCoverage } from '../../../domain/types'
import type { UniversalControl, UniversalControlType, UniversalOption } from './model'
import { controlOptionCoverage } from './optionCoverage'

const DANGEROUS = /提交|删除|移除|支付|购买|上传|发送验证码|下一步|保存|submit|delete|remove|pay|buy|upload|next|save/i

export interface BehaviorProbeResult {
  confirmed: boolean
  type: UniversalControlType
  options: UniversalOption[]
  optionCoverage: OptionCoverage
  popup?: HTMLElement
  evidence: string[]
  error?: 'unsafe-candidate' | 'popup-not-found' | 'value-changed'
}

interface ProbeSnapshot {
  node: HTMLElement
  value?: string
  checked?: boolean
  selected?: boolean[]
  aria: Array<[string, string | null]>
}

const STATE_ATTRIBUTES = ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed']

function takeProbeSnapshot(element: HTMLElement): ProbeSnapshot[] {
  const nodes = [element, ...Array.from(element.querySelectorAll<HTMLElement>('input,textarea,select,[aria-expanded],[aria-checked],[aria-selected],[aria-pressed]'))]
  return [...new Set(nodes)].map(node => ({
    node,
    value: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement ? node.value : undefined,
    checked: node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type) ? node.checked : undefined,
    selected: node instanceof HTMLSelectElement ? Array.from(node.options).map(option => option.selected) : undefined,
    aria: STATE_ATTRIBUTES.map(name => [name, node.getAttribute(name)] as [string, string | null])
  }))
}

function restoreProbeSnapshot(snapshot: ProbeSnapshot[]): void {
  for (const state of snapshot) {
    const node = state.node
    if (!node.isConnected) continue
    let changed = false
    if (state.value !== undefined && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) && node.value !== state.value) {
      node.value = state.value
      changed = true
    }
    if (state.checked !== undefined && node instanceof HTMLInputElement && node.checked !== state.checked) {
      node.checked = state.checked
      changed = true
    }
    if (state.selected && node instanceof HTMLSelectElement) {
      const options = Array.from(node.options)
      if (options.some((option, index) => option.selected !== (state.selected?.[index] ?? false))) {
        options.forEach((option, index) => { option.selected = state.selected?.[index] ?? false })
        changed = true
      }
    }
    for (const [name, value] of state.aria) {
      if (value == null) node.removeAttribute(name)
      else node.setAttribute(name, value)
    }
    if (changed) {
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
}

function safeToProbe(control: UniversalControl): boolean {
  const element = control.element
  if (!control.capabilities.canClick || control.type === 'file' || !element.isConnected || !isElementVisible(element)) return false
  if (element.matches('a,[type="submit"],[type="reset"],[type="file"]')
    || (element instanceof HTMLButtonElement && element.type === 'submit')
    || element.getAttribute('aria-haspopup') === 'dialog') return false
  const text = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.textContent || ''}`.replace(/\s+/g, ' ').trim().slice(0, 100)
  return !DANGEROUS.test(text)
}

function click(element: HTMLElement): void {
  const options: MouseEventInit = { bubbles: true, cancelable: true }
  element.dispatchEvent(new MouseEvent('pointerdown', options))
  element.dispatchEvent(new MouseEvent('mousedown', options))
  element.dispatchEvent(new MouseEvent('pointerup', options))
  element.dispatchEvent(new MouseEvent('mouseup', options))
  element.click()
}

function triggerOf(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>('[role="combobox"],[aria-haspopup],input[readonly]:not([type="submit"]):not([type="reset"]):not([type="file"]),input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="file"])') || element
}

function optionOf(element: HTMLElement, index: number): UniversalOption {
  return {
    id: element.id || `visible-${index + 1}`,
    label: (element.textContent || '').replace(/\s+/g, ' ').trim(),
    value: element.getAttribute('data-value') || element.getAttribute('value') || undefined,
    disabled: element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled'),
    selected: element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true' || /(?:^|\s)(?:selected|checked|is-selected|is-checked)(?:\s|$)/.test(typeof element.className === 'string' ? element.className : ''),
    element
  }
}

function typeFromPopup(control: UniversalControl, popup: HTMLElement): UniversalControlType {
  const role = popup.getAttribute('role')
  if (role === 'tree') return 'cascade'
  if (popup.getAttribute('aria-multiselectable') === 'true') return 'multi-select'
  if (role === 'grid' && /date|calendar|日期|年月/i.test(`${control.label} ${String(popup.className || '')}`)) return 'date'
  return control.type === 'unknown' ? 'select' : control.type
}

async function restoreProbe(trigger: HTMLElement, popup: HTMLElement | null, previousFocus: HTMLElement | null, scrollX: number, scrollY: number): Promise<void> {
  const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  trigger.dispatchEvent(escape)
  document.dispatchEvent(escape)
  await wait(30)
  if (popup?.isConnected && isElementVisible(popup)) {
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    document.body.click()
    await wait(30)
  }
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  try { window.scrollTo(scrollX, scrollY) } catch { /* 嵌入环境不支持恢复滚动时不影响探测收尾 */ }
}

/**
 * 只对高概率、安全候选执行“展开—观察—恢复”。不选择任何选项，也不输入文本。
 */
export async function probeControlBehavior(control: UniversalControl, readBack: () => string, timeoutMs = 480): Promise<BehaviorProbeResult> {
  if (!safeToProbe(control)) {
    return { confirmed: false, type: control.type, options: control.options, optionCoverage: control.optionCoverage, evidence: [], error: 'unsafe-candidate' }
  }
  const trigger = triggerOf(control.element)
  const beforeValue = readBack()
  const snapshot = takeProbeSnapshot(control.element)
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const watch = watchForPopup(trigger)
  let popup: HTMLElement | null = null
  try {
    trigger.focus({ preventScroll: true })
    click(trigger)
    popup = await watch.locate(timeoutMs)
    if (!popup) {
      return { confirmed: false, type: control.type, options: control.options, optionCoverage: control.optionCoverage, evidence: [], error: 'popup-not-found' }
    }
    const nodes = popupOptions(popup)
    const options = nodes.map(optionOf).filter(option => option.label && !option.disabled)
    const type = typeFromPopup(control, popup)
    const coverage = controlOptionCoverage(type, control.element, options.length, true)
    const afterValue = readBack()
    if (afterValue !== beforeValue) {
      restoreProbeSnapshot(snapshot)
      return { confirmed: false, type, options: control.options, optionCoverage: control.optionCoverage, evidence: [], error: 'value-changed' }
    }
    control.type = type
    control.options = options
    control.optionCoverage = coverage
    control.popup = popup
    control.capabilities = {
      ...control.capabilities,
      canClick: true,
      canScroll: options.length > 0,
      canSearch: control.capabilities.canSearch || Boolean(trigger.querySelector('input:not([readonly])'))
    }
    control.evidence.push('behavior:popup-opened', `behavior:options-${options.length}`)
    control.confidence = Math.max(control.confidence, options.length ? 0.9 : 0.76)
    return { confirmed: true, type, options, optionCoverage: coverage, popup, evidence: ['behavior:popup-opened', `behavior:options-${options.length}`] }
  } finally {
    watch.dispose()
    await restoreProbe(trigger, popup, previousFocus, scrollX, scrollY)
    restoreProbeSnapshot(snapshot)
  }
}

