/**
 * Service worker：注入（allFrames）+ 跨 frame 消息中继（TECH_DESIGN §10）。
 *
 * frame 间通信走 background 中继而不是 window.postMessage：
 * 跨源 iframe 无法可靠握手，且面板本身已占用 postMessage 通道。
 */

/** tabId → 已注册的 frameId 集合（frame 注入完成后通过 FRAME_HELLO 上报）。 */
import { agreeOnVisualCandidate, rankVisualCandidates, type OcrCandidate, type VisualBox } from '../../features/autofill/write/visualConsensus'
import { verifyVisualCandidate, visualAiConfigured, visualCapabilityState } from '../../features/ai/visualVerifier'

const tabFrames = new Map<number, Set<number>>()

/**
 * 用户明确打开过面板的标签页。使用 session storage 而不是只放在 service
 * worker 内存中，避免 Manifest V3 后台休眠后忘记状态。标签页刷新或跳转时
 * 保持开启，只有用户点“关闭”（面板按钮或再次点击扩展图标）才清除。
 */
const OPEN_PANEL_TABS_KEY = 'openPanelTabsV1'
const openPanelTabs = new Set<number>()
const openPanelTabsReady = chrome.storage.session.get(OPEN_PANEL_TABS_KEY).then(stored => {
  const tabIds = stored[OPEN_PANEL_TABS_KEY]
  if (!Array.isArray(tabIds)) return
  for (const tabId of tabIds) {
    if (Number.isInteger(tabId)) openPanelTabs.add(tabId)
  }
})

async function setPanelOpen(tabId: number, open: boolean): Promise<void> {
  await openPanelTabsReady
  if (open) openPanelTabs.add(tabId)
  else openPanelTabs.delete(tabId)
  await chrome.storage.session.set({ [OPEN_PANEL_TABS_KEY]: [...openPanelTabs] })
}

async function isPanelOpen(tabId: number): Promise<boolean> {
  await openPanelTabsReady
  return openPanelTabs.has(tabId)
}

async function injectContent(tabId: number): Promise<void> {
  tabFrames.delete(tabId)
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js']
  })
}

async function tellTopFrame(tabId: number, type: 'PANEL_OPEN' | 'PANEL_CLOSE'): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 })
}

interface VisualReply {
  ok?: boolean
  available?: boolean
  ocrAvailable?: boolean
  aiAvailable?: boolean
  error?: string
  [key: string]: unknown
}

let creatingOffscreen: Promise<void> | null = null

async function ensureOcrDocument(): Promise<void> {
  if (!chrome.offscreen) throw new Error('当前 Edge 版本不支持扩展离屏 OCR')
  if (await chrome.offscreen.hasDocument()) return
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: '在扩展内部运行本地 OCR，不上传完整页面截图'
    }).finally(() => { creatingOffscreen = null })
  }
  await creatingOffscreen
}

async function callLocalOcr(message: Record<string, unknown>, timeoutMs: number): Promise<VisualReply> {
  try {
    await ensureOcrDocument()
    return await Promise.race([
      chrome.runtime.sendMessage(message) as Promise<VisualReply>,
      new Promise<VisualReply>(resolve => setTimeout(() => resolve({ ok: false, available: false, error: '本地 OCR 识别超时' }), timeoutMs))
    ])
  } catch (error) {
    return { ok: false, available: false, error: `本地 OCR 不可用：${String(error)}` }
  }
}

interface VisualRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function rectFrom(value: unknown): VisualRect | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const left = finiteNumber(row.left)
  const top = finiteNumber(row.top)
  const right = finiteNumber(row.right)
  const bottom = finiteNumber(row.bottom)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
  }
  return btoa(binary)
}

/** 只把目标附近裁剪图交给本机 OCR，减少传输、识别耗时和敏感页面暴露范围。 */
async function cropVisualScreenshot(dataUrl: string, message: Record<string, unknown>): Promise<{
  image: string
  pixelSize: { width: number; height: number }
  viewport: { width: number; height: number; devicePixelRatio: number }
  region: VisualRect
  trigger: VisualRect
  origin: { x: number; y: number }
}> {
  const requested = rectFrom(message.region)
  const trigger = rectFrom(message.trigger)
  const viewportInput = message.viewport && typeof message.viewport === 'object' ? message.viewport as Record<string, unknown> : {}
  const viewportWidth = Math.max(1, finiteNumber(viewportInput.width, requested?.right || 1))
  const viewportHeight = Math.max(1, finiteNumber(viewportInput.height, requested?.bottom || 1))
  const region = requested || { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight, width: viewportWidth, height: viewportHeight }
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  try {
    const scaleX = bitmap.width / viewportWidth
    const scaleY = bitmap.height / viewportHeight
    const sourceX = Math.max(0, Math.floor(region.left * scaleX))
    const sourceY = Math.max(0, Math.floor(region.top * scaleY))
    const sourceRight = Math.min(bitmap.width, Math.ceil(region.right * scaleX))
    const sourceBottom = Math.min(bitmap.height, Math.ceil(region.bottom * scaleY))
    const width = Math.max(1, sourceRight - sourceX)
    const height = Math.max(1, sourceBottom - sourceY)
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建截图画布')
    context.drawImage(bitmap, sourceX, sourceY, width, height, 0, 0, width, height)
    const cropped = await canvas.convertToBlob({ type: 'image/png' })
    const image = bytesToBase64(new Uint8Array(await cropped.arrayBuffer()))
    const relativeTrigger = trigger
      ? {
          left: trigger.left - region.left,
          top: trigger.top - region.top,
          right: trigger.right - region.left,
          bottom: trigger.bottom - region.top,
          width: trigger.width,
          height: trigger.height
        }
      : { left: 0, top: 0, right: region.width, bottom: region.height, width: region.width, height: region.height }
    const croppedViewport = { width: region.width, height: region.height, devicePixelRatio: finiteNumber(viewportInput.devicePixelRatio, 1) }
    return {
      image,
      pixelSize: { width, height },
      viewport: croppedViewport,
      region: { left: 0, top: 0, right: region.width, bottom: region.height, width: region.width, height: region.height },
      trigger: relativeTrigger,
      origin: { x: region.left, y: region.top }
    }
  } finally {
    bitmap.close()
  }
}

function restoreVisualCoordinates(reply: VisualReply, origin: { x: number; y: number }): VisualReply {
  const restored = { ...reply }
  if (typeof restored.x === 'number') restored.x += origin.x
  if (typeof restored.y === 'number') restored.y += origin.y
  if (restored.box && typeof restored.box === 'object') {
    const box = restored.box as Record<string, unknown>
    restored.box = {
      ...box,
      left: finiteNumber(box.left) + origin.x,
      right: finiteNumber(box.right) + origin.x,
      top: finiteNumber(box.top) + origin.y,
      bottom: finiteNumber(box.bottom) + origin.y
    }
  }
  return restored
}

function scaleOcrCandidates(value: unknown, crop: Awaited<ReturnType<typeof cropVisualScreenshot>>): OcrCandidate[] {
  if (!Array.isArray(value)) return []
  const scaleX = crop.viewport.width / Math.max(1, crop.pixelSize.width)
  const scaleY = crop.viewport.height / Math.max(1, crop.pixelSize.height)
  return value.flatMap((item): OcrCandidate[] => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const source = rectFrom(row.box)
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    const id = typeof row.id === 'string' ? row.id : ''
    if (!source || !text || !id) return []
    return [{
      id,
      text,
      confidence: Math.max(0, Math.min(1, finiteNumber(row.confidence))),
      box: { left: source.left * scaleX, top: source.top * scaleY, right: source.right * scaleX, bottom: source.bottom * scaleY }
    }]
  })
}

async function captureForVisual(sender: chrome.runtime.MessageSender, message: Record<string, unknown>): Promise<VisualReply> {
  const tab = sender.tab
  if (!tab?.id || tab.windowId == null) return { ok: false, available: false, error: '无法确定当前标签页' }
  try {
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    const crop = await cropVisualScreenshot(screenshot, message)
    const ocr = await callLocalOcr({ type: 'LOCAL_OCR_RECOGNIZE', image: crop.image }, 30000)
    if (!ocr.ok) return { ...ocr, ocrAvailable: false, aiAvailable: await visualAiConfigured() }
    const targets = Array.isArray(message.targets) ? message.targets.map(String).filter(value => value.trim()) : []
    const mode = message.mode === 'verify' ? 'verify' : 'option'
    const candidates = scaleOcrCandidates(ocr.candidates, crop)
    const rankedWithDuplicates = rankVisualCandidates(candidates, targets, crop.trigger as VisualBox, mode)
    const seen = new Set<string>()
    const ranked = rankedWithDuplicates.filter(item => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    if (!ranked.length || ranked[0].score < 0.62) {
      return { ok: true, available: true, ocrAvailable: true, aiAvailable: await visualAiConfigured(), found: false, error: '本地 OCR 未找到高置信目标文字', engine: 'tesseract.js' }
    }
    const ai = await verifyVisualCandidate(crop.image, targets, mode, ranked, crop.viewport)
    const consensus = agreeOnVisualCandidate(ranked, ai)
    const selected = consensus.candidate
    const reply: VisualReply = {
      ok: true,
      available: true,
      ocrAvailable: true,
      aiAvailable: ai.available,
      found: consensus.found,
      confidence: consensus.confidence,
      error: consensus.error,
      engine: 'tesseract.js+vision-ai'
    }
    if (selected) {
      reply.text = selected.text
      reply.target = selected.target
      reply.box = selected.box
      reply.x = (selected.box.left + selected.box.right) / 2
      reply.y = (selected.box.top + selected.box.bottom) / 2
    }
    return restoreVisualCoordinates(reply, crop.origin)
  } catch (error) {
    return { ok: false, available: false, error: `页面截图失败：${String(error)}` }
  }
}

async function withDebugger(tabId: number, run: (target: chrome.debugger.Debuggee) => Promise<void>): Promise<VisualReply> {
  const target: chrome.debugger.Debuggee = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    await run(target)
    return { ok: true, available: true }
  } catch (error) {
    return { ok: false, available: true, error: `可信输入失败：${String(error)}` }
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined)
  }
}

async function dispatchRealClick(tabId: number, x: number, y: number): Promise<VisualReply> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { ok: false, error: '视觉坐标无效' }
  }
  return withDebugger(tabId, async target => {
    const common = { x, y, button: 'left' as const, clickCount: 1 }
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  })
}

async function dispatchTrustedText(tabId: number, text: string): Promise<VisualReply> {
  return withDebugger(tabId, async target => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft' })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace' })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text })
  })
}

async function dispatchTrustedScroll(tabId: number, x: number, y: number, deltaY: number): Promise<VisualReply> {
  if (![x, y, deltaY].every(Number.isFinite) || x < 0 || y < 0) return { ok: false, error: '滚轮坐标无效' }
  return withDebugger(tabId, async target => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  })
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  const tabId = tab.id
  try {
    if (await isPanelOpen(tabId)) {
      await setPanelOpen(tabId, false)
      await tellTopFrame(tabId, 'PANEL_CLOSE').catch(() => undefined)
      return
    }
    await setPanelOpen(tabId, true)
    await injectContent(tabId)
    await tellTopFrame(tabId, 'PANEL_OPEN').catch(() => undefined)
    await chrome.action.setBadgeText({ tabId, text: '' })
  } catch (error) {
    await setPanelOpen(tabId, false).catch(() => undefined)
    console.warn('无法在当前页面打开鸿途网申助手', error)
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef334b' })
    await chrome.action.setBadgeText({ tabId, text: '!' })
    await chrome.action.setTitle({ tabId, title: '当前页面禁止注入扩展，请在普通网页或已授权的本地页面打开' })
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return
  void (async () => {
    if (!(await isPanelOpen(tabId))) return
    try {
      await injectContent(tabId)
      await tellTopFrame(tabId, 'PANEL_OPEN').catch(() => undefined)
      await chrome.action.setBadgeText({ tabId, text: '' })
    } catch (error) {
      // 受限页面可能暂时无法注入；保留“开启”意图，之后进入普通页面仍会恢复。
      console.warn('页面刷新后暂时无法恢复鸿途网申助手', error)
    }
  })()
})

chrome.tabs.onRemoved.addListener(tabId => {
  tabFrames.delete(tabId)
  void setPanelOpen(tabId, false)
})
chrome.webNavigation?.onCommitted?.addListener?.(details => {
  if (details.frameId === 0) tabFrames.delete(details.tabId)
})

chrome.runtime.onMessage.addListener((message: { type: string; frameId?: number; fieldId?: string; value?: string; message?: object; added?: number; x?: number; y?: number; [key: string]: unknown }, sender, respond) => {
  const tabId = sender.tab?.id
  if (tabId == null) return false

  if (message.type === 'VISUAL_WARMUP') {
    Promise.all([
      callLocalOcr({ type: 'LOCAL_OCR_WARMUP' }, 60000),
      visualAiConfigured(),
      visualCapabilityState()
    ]).then(([ocr, aiAvailable, capability]) => respond({
      ...ocr,
      available: ocr.ok === true,
      ocrAvailable: ocr.ok === true,
      aiAvailable,
      aiVerified: capability.status === 'ready',
      aiRejected: capability.status === 'failed',
      aiTestedAt: capability.testedAt,
      engine: 'tesseract.js+vision-ai'
    }))
    return true
  }

  if (message.type === 'VISUAL_LOCATE_TEXT') {
    captureForVisual(sender, message).then(respond)
    return true
  }

  if (message.type === 'VISUAL_REAL_CLICK') {
    dispatchRealClick(tabId, Number(message.x), Number(message.y)).then(respond)
    return true
  }

  if (message.type === 'TRUSTED_CLICK') {
    dispatchRealClick(tabId, Number(message.x), Number(message.y)).then(respond)
    return true
  }

  if (message.type === 'TRUSTED_REPLACE_TEXT') {
    dispatchTrustedText(tabId, String(message.text || '')).then(respond)
    return true
  }

  if (message.type === 'TRUSTED_SCROLL') {
    dispatchTrustedScroll(tabId, Number(message.x), Number(message.y), Number(message.deltaY)).then(respond)
    return true
  }

  if (message.type === 'FRAME_HELLO') {
    const frames = tabFrames.get(tabId) || new Set<number>()
    frames.add(sender.frameId ?? 0)
    tabFrames.set(tabId, frames)
    respond({ frameId: sender.frameId ?? 0 })
    return false
  }

  if (message.type === 'PANEL_VISIBILITY_CHANGED') {
    setPanelOpen(tabId, message.open === true).then(() => respond({})).catch(error => respond({ error: String(error) }))
    return true
  }

  if (message.type === 'LIST_FRAMES') {
    const frames = tabFrames.get(tabId)
    respond({ frameIds: frames ? [...frames].sort((a, b) => a - b) : [0] })
    return false
  }

  if (message.type === 'FRAME_CALL') {
    const frameId = message.frameId ?? 0
    chrome.tabs.sendMessage(tabId, message.message, { frameId })
      .then(respond)
      .catch(error => respond({ error: String(error) }))
    return true
  }

  if (message.type === 'PAGE_MUTATED') {
    // 转发给顶层 frame 的协调者，由其通知面板（F16：只提示不动作）
    chrome.tabs.sendMessage(tabId, { type: 'FRAME_MUTATED', added: message.added || 0 }, { frameId: 0 }).catch(() => undefined)
    respond({})
    return false
  }

  if (message.type === 'FIELD_OBSERVED') {
    chrome.tabs.sendMessage(tabId, {
      type: 'FRAME_OBSERVED',
      fieldId: message.fieldId,
      value: message.value || '',
      sourceFrameId: sender.frameId ?? 0
    }, { frameId: 0 }).catch(() => undefined)
    respond({})
    return false
  }

  return false
})
