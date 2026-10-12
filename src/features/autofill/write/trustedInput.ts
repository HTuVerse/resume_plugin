interface TrustedInputReply {
  ok?: boolean
  error?: string
}

async function request(message: Record<string, unknown>): Promise<TrustedInputReply> {
  return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error) })) as Promise<TrustedInputReply>
}

function visibleCenter(element: HTMLElement): { x: number; y: number } | null {
  if (window.top !== window || !element.isConnected) return null
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const rect = element.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  const left = Math.max(0, rect.left)
  const right = Math.min(window.innerWidth, rect.right)
  const top = Math.max(0, rect.top)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  if (right - left < 2 || bottom - top < 2) return null
  const x = left + (right - left) / 2
  const y = top + (bottom - top) / 2
  return { x, y }
}

/** Chrome DevTools Protocol 产生 isTrusted=true 的真实鼠标事件；iframe 坐标未校准时拒绝。 */
export async function trustedClickElement(element: HTMLElement): Promise<boolean> {
  const point = visibleCenter(element)
  if (!point) return false
  const response = await request({ type: 'TRUSTED_CLICK', ...point })
  return response.ok === true
}

/** 聚焦后通过浏览器输入通道全选、清空、插入文本，供受控输入框拒绝合成事件时兜底。 */
export async function trustedReplaceText(element: HTMLElement, text: string): Promise<boolean> {
  if (!element.isConnected) return false
  element.focus({ preventScroll: true })
  const response = await request({ type: 'TRUSTED_REPLACE_TEXT', text })
  return response.ok === true
}

/** 对顶层页面指定滚动容器发送真实滚轮事件。 */
export async function trustedScrollElement(element: HTMLElement, deltaY: number): Promise<boolean> {
  const point = visibleCenter(element)
  if (!point) return false
  const response = await request({ type: 'TRUSTED_SCROLL', ...point, deltaY })
  return response.ok === true
}
