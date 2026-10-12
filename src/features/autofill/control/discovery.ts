import { discoverAriaControls } from './ariaDiscovery'
import { discoverNativeControls } from './nativeDiscovery'
import type { ControlDiscovery } from './model'
import { discoverPlatformControls } from '../platforms/registry'

const BEHAVIOR_CANDIDATE = '[tabindex]:not([tabindex="-1"]),[data-value],[data-placeholder],[class*="trigger"],[class*="selector"]'
const FORM_CONTEXT = 'form,fieldset,[role="group"],[class*="form-item"],[class*="form_item"],[class*="field"],[class*="control"]'
const DANGEROUS = /提交|确认提交|删除|移除|支付|购买|上传|发送验证码|下一步|保存|取消|关闭|submit|delete|remove|pay|buy|upload|next|save|cancel|close/i
const SELECT_HINT = /请选择|选择|搜索并选择|select|choose|dropdown|下拉/i

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[data-resume-assistant]') || !element.getClientRects().length) return false
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function behaviorCandidates(scope: ParentNode, claimed: Set<HTMLElement>): ControlDiscovery[] {
  const rows: ControlDiscovery[] = []
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>(BEHAVIOR_CANDIDATE))) {
    if (claimed.has(element) || !visible(element) || !element.closest(FORM_CONTEXT)) continue
    if (element.matches('a,[type="submit"],[type="reset"],[type="file"]')
      || (element instanceof HTMLButtonElement && element.type === 'submit')
      || element.getAttribute('aria-haspopup') === 'dialog') continue
    const shortText = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''} ${element.getAttribute('data-placeholder') || ''} ${element.textContent || ''}`
      .replace(/\s+/g, ' ').trim().slice(0, 100)
    if (DANGEROUS.test(shortText)) continue
    const inner = element.querySelector<HTMLInputElement>('input:not([type="hidden"])')
    const selectSignal = SELECT_HINT.test(shortText)
      || Boolean(inner?.readOnly)
      || element.hasAttribute('data-value')
      || /trigger|selector/i.test(typeof element.className === 'string' ? element.className : '')
    if (!selectSignal) continue
    rows.push({
      element,
      type: /日期|年月|date|calendar/i.test(shortText) ? 'date' : 'select',
      confidence: 0.62,
      evidence: ['behavior-candidate:focusable-form-trigger'],
      capabilities: { canClick: true, canUseKeyboard: element.tabIndex >= 0, canSearch: Boolean(inner && !inner.readOnly), canScroll: true }
    })
  }
  return rows
}

function walkScopes(root: ParentNode): ParentNode[] {
  const scopes: ParentNode[] = []
  const visit = (scope: ParentNode) => {
    scopes.push(scope)
    for (const host of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
      if (host.shadowRoot) visit(host.shadowRoot)
    }
  }
  visit(root)
  return scopes
}

/** 原生、ARIA、行为候选统一编排；同一元素合并证据并保留更强分类。 */
export function discoverUniversalControls(root: ParentNode): ControlDiscovery[] {
  const merged = new Map<HTMLElement, ControlDiscovery>()
  const accept = (row: ControlDiscovery) => {
    const current = merged.get(row.element)
    if (!current) {
      merged.set(row.element, row)
      return
    }
    const stronger = row.confidence > current.confidence ? row : current
    merged.set(row.element, {
      ...stronger,
      confidence: Math.max(current.confidence, row.confidence),
      evidence: [...new Set([...current.evidence, ...row.evidence])],
      capabilities: { ...current.capabilities, ...row.capabilities }
    })
  }
  for (const scope of walkScopes(root)) {
    discoverNativeControls(scope).forEach(accept)
    discoverAriaControls(scope).forEach(accept)
    discoverPlatformControls(scope).forEach(accept)
  }
  const claimed = new Set(merged.keys())
  for (const scope of walkScopes(root)) behaviorCandidates(scope, claimed).forEach(accept)
  return [...merged.values()]
}

