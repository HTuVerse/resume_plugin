import type { ControlDiscovery, UniversalControlType } from './model'

const ARIA_SELECTOR = [
  '[role="combobox"]', '[role="textbox"]', '[role="spinbutton"]',
  '[role="radio"]', '[role="checkbox"]', '[role="switch"]', '[role="radiogroup"]',
  '[aria-haspopup="listbox"]', '[aria-haspopup="tree"]', '[aria-haspopup="grid"]',
  '[aria-expanded][aria-controls]', '[aria-autocomplete]', '[aria-multiselectable="true"]',
  '[aria-checked]', '[aria-pressed]'
].join(',')

function ariaType(element: HTMLElement): UniversalControlType | null {
  const role = element.getAttribute('role')
  if (role === 'textbox') return element.getAttribute('aria-multiline') === 'true' ? 'textarea' : 'text'
  if (role === 'spinbutton') return 'text'
  if (role === 'radiogroup' || role === 'radio') return 'single-choice'
  if (role === 'checkbox' || role === 'switch' || element.hasAttribute('aria-pressed')) return 'multi-choice'
  if (element.getAttribute('aria-multiselectable') === 'true') return 'multi-select'
  const popup = element.getAttribute('aria-haspopup') || role
  if (popup === 'tree') return 'cascade'
  if (popup === 'grid' && /date|calendar|日期|年月/i.test(`${element.getAttribute('aria-label') || ''} ${String(element.className || '')}`)) return 'date'
  if (popup === 'listbox' || role === 'combobox' || element.hasAttribute('aria-autocomplete')) return 'select'
  if (element.hasAttribute('aria-expanded') && element.hasAttribute('aria-controls')) return 'select'
  return null
}

export function discoverAriaControls(scope: ParentNode): ControlDiscovery[] {
  const rows: ControlDiscovery[] = []
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>(ARIA_SELECTOR))) {
    const type = ariaType(element)
    if (!type) continue
    const role = element.getAttribute('role') || 'state'
    rows.push({
      element,
      type,
      confidence: role === 'state' ? 0.78 : 0.92,
      evidence: [`aria:${role}`, ...['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-checked', 'aria-selected']
        .filter(name => element.hasAttribute(name)).map(name => `${name}:${element.getAttribute(name)}`)]
    })
  }
  return rows
}

