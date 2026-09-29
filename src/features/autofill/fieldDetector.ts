import type { FieldKind } from '../../domain/types'
import { optionLabel } from './scan/labelResolver'

/**
 * 控件类型判定（R3 修复）：
 * - 自定义级联组件（ant-cascader / el-cascader）判为 cascade，不再落到 combobox。
 * - 组件库日期控件（ant-picker / el-date-editor）判为 date，走日期归一化。
 */

const CUSTOM_CASCADER_SELECTOR = '.ant-cascader,.el-cascader,.arco-cascader,[class*="cascader"]'
const CUSTOM_DATE_SELECTOR = '.ant-picker,.el-date-editor,.arco-picker,.ivu-date-picker,.n-date-picker,[class*="date-picker"],[class*="datepicker"]'
const CUSTOM_TIME_SELECTOR = '.el-time-picker,.el-time-select,.ant-picker-time-panel,[class*="time-picker"],[class*="timepicker"]'
const NATIVE_TEMPORAL = ['date', 'month', 'time', 'datetime-local', 'week']
export const CUSTOM_SELECT_SELECTOR = '.ant-select,.el-select,.arco-select,.n-select,.ivu-select'

function hintText(element: HTMLElement): string {
  const className = typeof element.className === 'string' ? element.className : ''
  return `${element.getAttribute('placeholder') || ''} ${element.getAttribute('format') || ''} ${className}`
}

/** 日期、月份、时间选择器。可编辑的普通输入框即使文案里有「时间」也不算。 */
export function isDateLikeControl(element: HTMLElement): boolean {
  if (element.closest(CUSTOM_DATE_SELECTOR) || element.closest(CUSTOM_TIME_SELECTOR)) return true
  if (element instanceof HTMLInputElement && NATIVE_TEMPORAL.includes(element.type)) return true
  const hint = hintText(element)
  if (/yyyy|YYYY|date-?picker|time-?picker|日期|年月/.test(hint)) return true
  const readonly = element instanceof HTMLInputElement && element.readOnly
  return readonly && /时间/.test(hint)
}

/** 组件库下拉，或只读且占位是「请选择」的输入。日期选择器优先归到日期。 */
export function isSelectLikeControl(element: HTMLElement): boolean {
  if (isDateLikeControl(element)) return false
  if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') return true
  if (element.closest(CUSTOM_SELECT_SELECTOR) || element.closest(CUSTOM_CASCADER_SELECTOR)) return true
  return element instanceof HTMLInputElement && element.readOnly && /请选择/.test(element.getAttribute('placeholder') || '')
}

export function detectFieldKind(element: HTMLElement, label: string, group: string): FieldKind {
  if (element instanceof HTMLSelectElement) {
    if (element.multiple) return 'multiselect'
    return /省|市|区|县|国家|地区|地址|所在地|居住地|province|city|district|region/i.test(`${label} ${group}`) ? 'cascade' : 'select'
  }
  if (element instanceof HTMLTextAreaElement) return 'textarea'
  if (element instanceof HTMLInputElement) {
    if (isDateLikeControl(element)) return 'date'
    if (element.type === 'radio') return 'radio'
    if (element.type === 'checkbox') return 'checkbox'
    if (element.closest(CUSTOM_CASCADER_SELECTOR)) return 'cascade'
    if (isSelectLikeControl(element)) return 'combobox'
    return 'text'
  }
  if (element.closest(CUSTOM_CASCADER_SELECTOR)) return 'cascade'
  if (isDateLikeControl(element)) return 'date'
  if (element.getAttribute('role') === 'combobox' || element.closest(CUSTOM_SELECT_SELECTOR)) return 'combobox'
  if (element.isContentEditable) return 'textarea'
  return 'text'
}

export function getFieldOptions(kind: FieldKind, element: HTMLElement, radios?: HTMLInputElement[], checkboxes?: HTMLInputElement[]): string[] {
  if (kind === 'select' || kind === 'multiselect' || (kind === 'cascade' && element instanceof HTMLSelectElement)) {
    return Array.from((element as HTMLSelectElement).options).filter(option => !option.disabled).map(option => option.text.trim()).filter(Boolean)
  }
  if (kind === 'radio') return (radios || []).map(radio => optionLabel(radio)).filter(Boolean)
  if (kind === 'checkbox') return (checkboxes || []).map(checkbox => optionLabel(checkbox)).filter(Boolean)
  return []
}
