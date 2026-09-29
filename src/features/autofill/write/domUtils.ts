/** DOM 写入基础工具（从 autofillEngine 迁入，TECH_DESIGN §15）。 */

export function dispatchFieldEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  element.dispatchEvent(new Event('blur', { bubbles: true }))
}

/** 通过原型 setter 写入，兼容 React/Vue 受控组件。 */
export function setNativeText(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
  if (descriptor?.set) descriptor.set.call(element, value)
  else element.value = value
  dispatchFieldEvents(element)
}

/** select.value 走原型 setter，否则 React/Vue 收不到下拉变更。 */
export function setNativeSelect(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
  if (descriptor?.set) descriptor.set.call(select, value)
  else select.value = value
  dispatchFieldEvents(select)
}

/** radio / checkbox 的 checked 同样要走原型 setter。 */
export function setNativeChecked(input: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
  if (descriptor?.set) descriptor.set.call(input, checked)
  else input.checked = checked
  dispatchFieldEvents(input)
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[data-resume-assistant]')) return false
  if (!element.getClientRects().length) return false
  const style = getComputedStyle(element)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (style.opacity === '0') return false
  return true
}

/** 轮询直到 predicate 返回真值或超时。间隔递增（30/60/120/240/480ms）。 */
export async function pollUntil<T>(predicate: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  const intervals = [30, 60, 120, 240, 480]
  const start = Date.now()
  let step = 0
  for (;;) {
    const result = predicate()
    if (result) return result
    if (Date.now() - start >= timeoutMs) return null
    await wait(intervals[Math.min(step, intervals.length - 1)])
    step += 1
  }
}
