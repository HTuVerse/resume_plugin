import type { ControlDiscovery } from '../control/model'
import { beisenLegacyAdapter, beisenPhoenixAdapter } from './beisen'
import type { PlatformAdapter, PlatformMatch, PlatformSelectors } from './contracts'
import { feishuAdapter } from './feishu'
import { mokaAdapter } from './moka'

export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  beisenPhoenixAdapter,
  feishuAdapter,
  mokaAdapter,
  beisenLegacyAdapter
]

type SelectorKey = keyof PlatformSelectors

function joinSelectors(key: SelectorKey): string {
  return [...new Set(PLATFORM_ADAPTERS.flatMap(adapter => adapter.selectors[key].split(',')).map(value => value.trim()).filter(Boolean))].join(',')
}

export const PLATFORM_FORM_ITEM_SELECTOR = joinSelectors('formItem')
export const PLATFORM_LABEL_SELECTOR = joinSelectors('label')
export const PLATFORM_SECTION_SELECTOR = joinSelectors('section')
export const PLATFORM_REPEAT_ITEM_SELECTOR = joinSelectors('repeatItem')
export const PLATFORM_SELECT_SELECTOR = joinSelectors('select')
export const PLATFORM_CASCADE_SELECTOR = joinSelectors('cascade')
export const PLATFORM_DATE_SELECTOR = joinSelectors('date')
export const PLATFORM_CONTROL_HOST_SELECTOR = [PLATFORM_SELECT_SELECTOR, PLATFORM_CASCADE_SELECTOR, PLATFORM_DATE_SELECTOR].filter(Boolean).join(',')
export const PLATFORM_POPUP_SELECTOR = joinSelectors('popup')
export const PLATFORM_OPTION_SELECTOR = joinSelectors('option')
export const PLATFORM_SELECTION_ITEM_SELECTOR = joinSelectors('selectionItem')
export const PLATFORM_SEARCH_INPUT_SELECTOR = joinSelectors('searchInput')
export const PLATFORM_CHOICE_WRAPPER_SELECTOR = joinSelectors('choiceWrapper')
export const PLATFORM_RADIO_GROUP_SELECTOR = joinSelectors('radioGroup')
export const PLATFORM_CHECKBOX_GROUP_SELECTOR = joinSelectors('checkboxGroup')
export const PLATFORM_RANGE_SELECTOR = joinSelectors('range')

function contextUrl(root: ParentNode, explicit?: string): URL | null {
  if (explicit) {
    try { return new URL(explicit) } catch { return null }
  }
  const doc = root instanceof Document ? root : root.ownerDocument
  try { return new URL(doc?.location?.href || location.href) } catch { return null }
}

function indicatorHits(adapter: PlatformAdapter, root: ParentNode): string[] {
  return adapter.indicators.filter(selector => {
    try { return Boolean(root.querySelector(selector)) } catch { return false }
  })
}

export function matchPlatformAdapter(adapter: PlatformAdapter, root: ParentNode, url?: string): PlatformMatch | null {
  const parsed = contextUrl(root, url)
  const hostHit = Boolean(parsed && adapter.hostPatterns.some(pattern => pattern.test(parsed.hostname)))
  const pathHit = Boolean(parsed && adapter.pathPatterns?.some(pattern => pattern.test(parsed.pathname)))
  const indicators = indicatorHits(adapter, root)
  if (!hostHit && indicators.length < adapter.indicatorOnlyThreshold) return null
  const confidence = Math.min(0.99,
    (hostHit ? 0.62 : 0)
    + (pathHit ? 0.12 : 0)
    + Math.min(0.32, indicators.length * 0.11))
  const evidence = [
    ...(hostHit ? [`host:${parsed?.hostname}`] : []),
    ...(pathHit ? [`path:${parsed?.pathname}`] : []),
    ...indicators.map(selector => `dom:${selector}`)
  ]
  return { adapter, confidence, evidence }
}

/** 单页只选择一个 ATS 世代；页面内的通用组件仍由能力识别器并行处理。 */
export function detectPlatform(root: ParentNode = document, url?: string): PlatformMatch | null {
  const matches = PLATFORM_ADAPTERS
    .map(adapter => matchPlatformAdapter(adapter, root, url))
    .filter((match): match is PlatformMatch => Boolean(match))
    .sort((left, right) => right.confidence - left.confidence || right.adapter.priority - left.adapter.priority)
  return matches[0] || null
}

export function platformAdapterForElement(element: HTMLElement): PlatformAdapter | null {
  const root = element.ownerDocument || document
  return detectPlatform(root)?.adapter || null
}

/**
 * 平台组件经常同时给外层容器和内层 control 加同族 class（例如 Moka sd-Select）。
 * 扫描、点击和回读必须引用同一个最外层宿主，否则会出现“选中了但回读为空”。
 */
export function platformControlHost(element: HTMLElement): HTMLElement | null {
  const adapter = platformAdapterForElement(element)
  if (!adapter) return null
  const selector = [adapter.selectors.select, adapter.selectors.cascade, adapter.selectors.date].filter(Boolean).join(',')
  if (!selector) return null
  let host: HTMLElement | null = null
  try { host = element.closest<HTMLElement>(selector) } catch { return null }
  if (!host) return null
  let parent = host.parentElement?.closest<HTMLElement>(selector) || null
  while (parent) {
    host = parent
    parent = host.parentElement?.closest<HTMLElement>(selector) || null
  }
  return host
}

export function discoverPlatformControls(scope: ParentNode): ControlDiscovery[] {
  const doc = scope instanceof Document ? scope : scope.ownerDocument
  const match = detectPlatform(doc || scope)
  if (!match) return []
  const rows: ControlDiscovery[] = []
  for (const hint of match.adapter.controls) {
    let elements: HTMLElement[] = []
    try { elements = Array.from(scope.querySelectorAll<HTMLElement>(hint.selector)) } catch { continue }
    for (const element of elements) {
      if (element.closest('[data-resume-assistant]')) continue
      rows.push({
        element,
        type: hint.type,
        confidence: hint.confidence ?? match.confidence,
        evidence: [`platform:${match.adapter.id}`, hint.evidence],
        capabilities: hint.capabilities
      })
    }
  }
  return rows
}

export function platformRepeatContainer(element: HTMLElement): HTMLElement | null {
  const adapter = platformAdapterForElement(element)
  if (!adapter?.selectors.repeatItem) return null
  try { return element.closest<HTMLElement>(adapter.selectors.repeatItem) } catch { return null }
}

/** 查找平台分区标题；仅接受短文本，避免把整块表单正文当标题。 */
export function platformSectionHeading(element: HTMLElement): string {
  const adapter = platformAdapterForElement(element)
  if (!adapter?.selectors.section) return ''
  const selectors = adapter.selectors.section.split(',').map(value => value.trim()).filter(Boolean)
  let node: HTMLElement | null = element.parentElement
  for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
    for (const selector of selectors) {
      const direct = Array.from(node.children).find(child => child instanceof HTMLElement && child.matches(selector))
      const text = direct?.textContent?.replace(/\s+/g, ' ').trim() || ''
      if (text && text.length < 80) return text
    }
    let sibling: Element | null = node.previousElementSibling
    for (let index = 0; sibling && index < 5; index += 1, sibling = sibling.previousElementSibling) {
      if (!(sibling instanceof HTMLElement)) continue
      if (!selectors.some(selector => sibling!.matches(selector))) continue
      const text = sibling.textContent?.replace(/\s+/g, ' ').trim() || ''
      if (text && text.length < 80) return text
    }
  }
  return ''
}

