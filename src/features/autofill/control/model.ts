import type { FieldKind, LabelSource, OptionCoverage } from '../../../domain/types'

export type UniversalControlType =
  | 'text'
  | 'textarea'
  | 'single-choice'
  | 'multi-choice'
  | 'select'
  | 'multi-select'
  | 'cascade'
  | 'date'
  | 'file'
  | 'unknown'

export interface ControlCapabilities {
  canSetNativeValue: boolean
  canType: boolean
  canClick: boolean
  canSearch: boolean
  canScroll: boolean
  canUseKeyboard: boolean
  canTrustedInput: boolean
  canReadBack: boolean
}

export interface UniversalOption {
  id?: string
  label: string
  value?: string
  disabled: boolean
  selected: boolean
  element?: HTMLElement
}

export interface UniversalControl {
  fingerprint: string
  type: UniversalControlType
  element: HTMLElement
  label: string
  labelSource: LabelSource
  currentValue: string
  options: UniversalOption[]
  optionCoverage: OptionCoverage
  capabilities: ControlCapabilities
  frameId?: number
  platformId?: string
  platformVersion?: string
  sectionId?: string
  repeatIndex?: number
  confidence: number
  evidence: string[]
  /** 行为探测后锁定的浮层；只在当前页面生命周期内有效。 */
  popup?: HTMLElement
}

export interface ControlDiscovery {
  element: HTMLElement
  type: UniversalControlType
  confidence: number
  evidence: string[]
  capabilities?: Partial<ControlCapabilities>
}

export function universalTypeFromFieldKind(kind: FieldKind, _optionCount = 0): UniversalControlType {
  switch (kind) {
    case 'text': return 'text'
    case 'textarea': return 'textarea'
    case 'radio': return 'single-choice'
    case 'checkbox': return 'multi-choice'
    case 'select': return 'select'
    case 'multiselect': return 'multi-select'
    case 'combobox': return 'select'
    case 'cascade': return 'cascade'
    case 'date': return 'date'
    case 'file': return 'file'
    default: return 'unknown'
  }
}

export function fieldKindFromUniversalType(type: UniversalControlType): FieldKind {
  switch (type) {
    case 'textarea': return 'textarea'
    case 'single-choice': return 'radio'
    case 'multi-choice': return 'checkbox'
    case 'select': return 'combobox'
    case 'multi-select': return 'multiselect'
    case 'cascade': return 'cascade'
    case 'date': return 'date'
    case 'file': return 'file'
    case 'text':
    case 'unknown':
    default: return 'text'
  }
}

function focusable(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return !element.disabled
  return element.tabIndex >= 0 || element.isContentEditable || /^(button|a)$/i.test(element.tagName)
}

export function inferCapabilities(element: HTMLElement, type: UniversalControlType): ControlCapabilities {
  const nativeValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
  const input = element instanceof HTMLInputElement ? element : element.querySelector<HTMLInputElement>('input:not([type="hidden"])')
  const choice = type === 'single-choice' || type === 'multi-choice'
  const selection = type === 'select' || type === 'multi-select' || type === 'cascade'
  const dangerous = type === 'file'
  return {
    canSetNativeValue: nativeValue && !choice && type !== 'file',
    canType: !dangerous && (type === 'text' || type === 'textarea' || type === 'date' || Boolean(input && !input.readOnly)),
    canClick: !dangerous && (choice || selection || type === 'date' || element instanceof HTMLSelectElement),
    canSearch: selection && Boolean(input && !input.readOnly),
    canScroll: selection,
    canUseKeyboard: !dangerous && (focusable(element) || Boolean(input)),
    canTrustedInput: !dangerous,
    canReadBack: type !== 'unknown' && type !== 'file'
  }
}

export function mergeCapabilities(base: ControlCapabilities, override?: Partial<ControlCapabilities>): ControlCapabilities {
  return override ? { ...base, ...override } : base
}

