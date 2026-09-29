let sequence = 0
const eventListeners = new Set<(event: any) => void>()
const parentOrigin = (() => {
  try { return document.referrer ? new URL(document.referrer).origin : '*' }
  catch { return '*' }
})()

function isParentMessage(event: MessageEvent): boolean {
  return event.source === window.parent && (parentOrigin === '*' || event.origin === parentOrigin)
}

window.addEventListener('message', event => {
  if (isParentMessage(event) && event.data?.type === 'PANEL_EVENT') {
    eventListeners.forEach(listener => listener(event.data.event))
  }
})

/** 只计算面板留在前台的时间。切到其它应用时页面计时会被暂停，不能把这段算进超时。 */
const FOREGROUND_TIMEOUT_MS = 180_000

export function requestContent<T = any>(message: object): Promise<T> {
  const requestId = `panel-${Date.now()}-${sequence++}`
  return new Promise((resolve, reject) => {
    let settled = false
    let active = 0
    let cursor = Date.now()
    const timer = window.setInterval(accrueForeground, 1000)

    function cleanup(): void {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('message', onMessage)
    }

    function finish(fn: () => void): void {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    function accrueForeground(): void {
      const now = Date.now()
      if (!document.hidden) {
        active += now - cursor
        if (active >= FOREGROUND_TIMEOUT_MS) {
          finish(() => reject(new Error('页面有一会儿没有回应。请留在网申页面再试一次，不用关闭面板。')))
        }
      }
      cursor = now
    }

    function onVisibility(): void {
      const now = Date.now()
      if (document.hidden) active += now - cursor
      cursor = now
    }

    function onMessage(event: MessageEvent): void {
      if (!isParentMessage(event) || event.data?.type !== 'PANEL_RESPONSE' || event.data.requestId !== requestId) return
      finish(() => resolve(event.data.response as T))
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('message', onMessage)
    window.parent.postMessage({ type: 'PANEL_REQUEST', requestId, message }, parentOrigin)
  })
}

export function closePanel(): void {
  window.parent.postMessage({ type: 'PANEL_REQUEST', requestId: `close-${Date.now()}`, message: { type: 'CLOSE_PANEL' } }, parentOrigin)
}

export function minimizePanel(): void {
  window.parent.postMessage({ type: 'PANEL_REQUEST', requestId: `minimize-${Date.now()}`, message: { type: 'MINIMIZE_PANEL' } }, parentOrigin)
}

export function resizePanel(mode: 'compact' | 'expanded' | 'activation'): void {
  window.parent.postMessage({ type: 'PANEL_REQUEST', requestId: `resize-${Date.now()}`, message: { type: 'RESIZE_PANEL', mode } }, parentOrigin)
}

export function beginPanelDrag(clientX: number, clientY: number): void {
  window.parent.postMessage({ type: 'PANEL_REQUEST', requestId: `drag-${Date.now()}`, message: { type: 'DRAG_PANEL', clientX, clientY } }, parentOrigin)
}

export function onContentEvent(listener: (event: any) => void): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}
