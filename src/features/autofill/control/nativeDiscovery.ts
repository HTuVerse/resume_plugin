import type { ControlDiscovery, UniversalControlType } from './model'

const NATIVE_SELECTOR = 'input,textarea,select,[contenteditable="true"]'
const IGNORED_INPUTS = new Set(['hidden', 'password', 'submit', 'reset', 'button', 'image'])

function nativeType(element: HTMLElement): UniversalControlType | null {
  if (element instanceof HTMLTextAreaElement || element.isContentEditable) return 'textarea'
  if (element instanceof HTMLSelectElement) return element.multiple ? 'multi-select' : 'select'
  if (!(element instanceof HTMLInputElement) || IGNORED_INPUTS.has(element.type) || element.disabled) return null
  if (element.type === 'file') return 'file'
  if (element.type === 'radio') return 'single-choice'
  if (element.type === 'checkbox') return 'multi-choice'
  if (['date', 'month', 'time', 'datetime-local', 'week'].includes(element.type)) return 'date'
  return 'text'
}

export function discoverNativeControls(scope: ParentNode): ControlDiscovery[] {
  const rows: ControlDiscovery[] = []
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>(NATIVE_SELECTOR))) {
    const type = nativeType(element)
    if (!type) continue
    rows.push({
      element,
      type,
      confidence: 1,
      evidence: [`native:${element.tagName.toLowerCase()}${element instanceof HTMLInputElement ? `[${element.type}]` : ''}`]
    })
  }
  return rows
}

