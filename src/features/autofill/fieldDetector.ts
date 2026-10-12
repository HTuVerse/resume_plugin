import type { FieldKind, OptionCoverage } from '../../domain/types'
import { isPlaceholderOption, plainChoiceText } from '../ontology/optionMatch'
import { optionLabel } from './scan/labelResolver'
import { controlOptionCoverage } from './control/optionCoverage'
import { universalTypeFromFieldKind } from './control/model'
import {
  PLATFORM_CASCADE_SELECTOR,
  PLATFORM_DATE_SELECTOR,
  PLATFORM_OPTION_SELECTOR,
  PLATFORM_SELECT_SELECTOR
} from './platforms/registry'

/**
 * 控件类型判定（R3 修复）：
 * - 自定义级联组件（ant-cascader / el-cascader）判为 cascade，不再落到 combobox。
 * - 组件库日期控件（ant-picker / el-date-editor）判为 date，走日期归一化。
 */

const CUSTOM_CASCADER_SELECTOR = ['.ant-cascader,.el-cascader,.arco-cascader,[class*="cascader"]', PLATFORM_CASCADE_SELECTOR].filter(Boolean).join(',')
const CUSTOM_DATE_SELECTOR = ['.ant-picker,.el-date-editor,.arco-picker,.ivu-date-picker,.n-date-picker,[class*="date-picker"],[class*="datepicker"]', PLATFORM_DATE_SELECTOR].filter(Boolean).join(',')
const CUSTOM_TIME_SELECTOR = '.el-time-picker,.el-time-select,.ant-picker-time-panel,[class*="time-picker"],[class*="timepicker"]'
const NATIVE_TEMPORAL = ['date', 'month', 'time', 'datetime-local', 'week']
export const CUSTOM_SELECT_SELECTOR = ['.ant-select,.el-select,.arco-select,.n-select,.ivu-select,.semi-select,.t-select', PLATFORM_SELECT_SELECTOR].filter(Boolean).join(',')

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

const WIDGET_OPTION = ['[role="option"],.ant-select-item-option,.el-select-dropdown__item,.arco-select-option,.n-base-select-option,.ivu-select-item,.t-select-option', PLATFORM_OPTION_SELECTOR].filter(Boolean).join(',')

/** 多选标签：Ant / Element 的 multiple 选择器，不是原生 select[multiple]。 */
export function isCustomMultiselect(element: HTMLElement): boolean {
  const host = element.closest(`${CUSTOM_SELECT_SELECTOR},[aria-multiselectable="true"]`) || element
  if (host.getAttribute('aria-multiselectable') === 'true') return true
  const className = typeof host.className === 'string' ? host.className : ''
  if (/(?:^|\s)(?:ant-select-multiple|el-select--multiple|arco-select-multiple|semi-select-multiple)(?:\s|$)/.test(className)) return true
  if (/\bis-multiple\b/.test(className)) return true
  if (host.querySelector('.ant-select-selection-overflow, .el-select__tags')) return true
  return false
}

function optionText(node: HTMLElement): string {
  return (node.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 控件自己或紧邻的下拉层里已经渲染出来的选项。弹层还没打开时为空。 */
export function widgetOptions(element: HTMLElement): string[] {
  const host = element.closest(`${CUSTOM_SELECT_SELECTOR},${CUSTOM_CASCADER_SELECTOR}`) || element
  const texts: string[] = []
  const take = (root: ParentNode) => {
    for (const node of Array.from(root.querySelectorAll<HTMLElement>(WIDGET_OPTION))) {
      const text = optionText(node)
      if (text && text.length < 40) texts.push(text)
    }
  }
  take(host)
  let sibling = host.nextElementSibling
  for (let index = 0; sibling && index < 2; index += 1, sibling = sibling.nextElementSibling) {
    if (sibling instanceof HTMLElement) take(sibling)
  }
  return [...new Set(texts)]
}

/** 组件库下拉，或只读且占位是「请选择」的输入。日期选择器优先归到日期。 */
export function isSelectLikeControl(element: HTMLElement): boolean {
  if (isDateLikeControl(element)) return false
  if (element.getAttribute('role') === 'combobox' || ['listbox', 'tree', 'menu'].includes(element.getAttribute('aria-haspopup') || '')) return true
  if (element.closest(CUSTOM_SELECT_SELECTOR) || element.closest(CUSTOM_CASCADER_SELECTOR)) return true
  return element instanceof HTMLInputElement && element.readOnly && /请选择/.test(element.getAttribute('placeholder') || '')
}

export function detectFieldKind(element: HTMLElement, label: string, group: string): FieldKind {
  if (element instanceof HTMLInputElement && element.type === 'file') return 'file'
  if (element instanceof HTMLSelectElement) {
    if (element.multiple) return 'multiselect'
    return /省|市|区|县|国家|地区|地址|所在地|居住地|province|city|district|region/i.test(`${label} ${group}`) ? 'cascade' : 'select'
  }
  if (element instanceof HTMLTextAreaElement) return 'textarea'
  if (element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'switch') return 'checkbox'
  if (element instanceof HTMLInputElement) {
    if (isDateLikeControl(element)) return 'date'
    if (element.type === 'radio') return 'radio'
    if (element.type === 'checkbox') return 'checkbox'
    if (element.closest(CUSTOM_CASCADER_SELECTOR)) return 'cascade'
    if (isCustomMultiselect(element)) return 'multiselect'
    if (isSelectLikeControl(element)) return 'combobox'
    return 'text'
  }
  if (element.closest(CUSTOM_CASCADER_SELECTOR)) return 'cascade'
  if (isDateLikeControl(element)) return 'date'
  if (isCustomMultiselect(element)) return 'multiselect'
  if (element.getAttribute('role') === 'combobox' || element.closest(CUSTOM_SELECT_SELECTOR)) return 'combobox'
  if (element.isContentEditable || element.getAttribute('role') === 'textbox') return 'textarea'
  if (element.getAttribute('role') === 'spinbutton') return 'text'
  return 'text'
}

/**
 * 原生静态 select 与直接渲染的选项组可视为完整；自定义弹层只暴露当前
 * 渲染片段，尤其是虚拟列表和远程搜索，必须保留为 partial/unknown。
 */
export function optionCoverageOf(kind: FieldKind, element: HTMLElement, options: string[]): OptionCoverage {
  return controlOptionCoverage(universalTypeFromFieldKind(kind, options.length), element, options.length)
}

export function getFieldOptions(kind: FieldKind, element: HTMLElement, radios?: HTMLInputElement[], checkboxes?: HTMLInputElement[]): string[] {
  if ((kind === 'select' || kind === 'multiselect' || kind === 'cascade') && element instanceof HTMLSelectElement) {
    return Array.from(element.options)
      .filter(option => !option.disabled)
      .map(option => plainChoiceText(option.text))
      .filter(text => text && !isPlaceholderOption(text))
  }
  if (kind === 'radio') return (radios || []).map(radio => optionLabel(radio)).filter(Boolean)
  if (kind === 'checkbox') return (checkboxes || []).map(checkbox => optionLabel(checkbox)).filter(Boolean)
  if (kind === 'combobox' || kind === 'multiselect' || kind === 'cascade') return widgetOptions(element)
  return []
}
