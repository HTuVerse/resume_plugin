// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestContent } from '../../src/app/bridge/panelBridge'

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

function respond(requestId: string, response: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    source: window.parent,
    origin: window.location.origin,
    data: { type: 'PANEL_RESPONSE', requestId, response }
  }))
}

describe('面板等待页面响应', () => {
  afterEach(() => {
    setHidden(false)
    vi.useRealTimers()
  })

  it('切到其它应用期间不计超时，回到页面后仍能收到填写结果', async () => {
    vi.useFakeTimers()
    const sent: Array<{ requestId?: string }> = []
    vi.spyOn(window.parent, 'postMessage').mockImplementation(data => {
      sent.push(data as { requestId?: string })
    })
    let failed = false
    const pending = requestContent({ type: 'FILL' }).catch(error => {
      failed = true
      throw error
    })
    const requestId = sent[0]?.requestId || ''
    setHidden(true)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(failed).toBe(false)
    setHidden(false)
    respond(requestId, { results: [{ status: 'filled' }] })
    await expect(pending).resolves.toEqual({ results: [{ status: 'filled' }] })
  })

  it('一直留在前台且页面无响应时才超时，且不必关闭面板', async () => {
    vi.useFakeTimers()
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    const pending = requestContent({ type: 'SCAN' })
    const assertion = expect(pending).rejects.toThrow('不用关闭面板')
    await vi.advanceTimersByTimeAsync(180_000)
    await assertion
  })
})
