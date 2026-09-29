/**
 * Service worker：注入（allFrames）+ 跨 frame 消息中继（TECH_DESIGN §10）。
 *
 * frame 间通信走 background 中继而不是 window.postMessage：
 * 跨源 iframe 无法可靠握手，且面板本身已占用 postMessage 通道。
 */

/** tabId → 已注册的 frameId 集合（frame 注入完成后通过 FRAME_HELLO 上报）。 */
const tabFrames = new Map<number, Set<number>>()

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  try {
    tabFrames.delete(tab.id)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    })
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' })
  } catch (error) {
    console.warn('无法在当前页面打开鸿途网申助手', error)
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#ef334b' })
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' })
    await chrome.action.setTitle({ tabId: tab.id, title: '当前页面禁止注入扩展，请在普通网页或已授权的本地页面打开' })
  }
})

chrome.tabs.onRemoved.addListener(tabId => tabFrames.delete(tabId))
chrome.webNavigation?.onCommitted?.addListener?.(details => {
  if (details.frameId === 0) tabFrames.delete(details.tabId)
})

chrome.runtime.onMessage.addListener((message: { type: string; frameId?: number; fieldId?: string; value?: string; message?: object; added?: number }, sender, respond) => {
  const tabId = sender.tab?.id
  if (tabId == null) return false

  if (message.type === 'FRAME_HELLO') {
    const frames = tabFrames.get(tabId) || new Set<number>()
    frames.add(sender.frameId ?? 0)
    tabFrames.set(tabId, frames)
    respond({ frameId: sender.frameId ?? 0 })
    return false
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
