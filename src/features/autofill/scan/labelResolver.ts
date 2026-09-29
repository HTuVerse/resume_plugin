import type { LabelSource } from '../../../domain/types'

/**
 * 标签抽取（从旧 content.labelOf 迁出，F02 前置）。
 *
 * 新增：抽取结果携带来源级别 labelSource。来源越弱（sibling/placeholder），
 * 打分时标签类信号的权重越低——这是「标签抽错导致填错」的主要防线。
 */

export interface ResolvedLabel {
  text: string
  source: LabelSource
}

/** 表单项容器选择器：由识别器补充（§4.2），此处是通用兜底集合。 */
const FORM_ITEM_SELECTOR = '.ant-form-item,.el-form-item,.arco-form-item,.n-form-item,.ivu-form-item,.form-group,.form-item,.field,[data-field]'
const FORM_ITEM_LABEL_SELECTOR = 'label,.ant-form-item-label,.el-form-item__label,.arco-form-item-label,.n-form-item-label,.ivu-form-item-label,legend,.label'
const CHOICE_GROUP_SELECTOR = '[role="radiogroup"],[role="group"],.ant-radio-group,.el-radio-group,.arco-radio-group,.ant-checkbox-group,.el-checkbox-group,fieldset'

function cleanText(text: string | null | undefined): string {
  return String(text || '').replace(/\s+/g, ' ').replace(/[*＊:：]\s*$/, '').trim()
}

export function resolveLabel(element: HTMLElement): ResolvedLabel {
  // 1. label[for] / 包裹型 label（最强）
  if ('labels' in element) {
    const labels = (element as HTMLInputElement).labels
    if (labels?.length) {
      const text = cleanText(Array.from(labels).map(label => label.textContent || '').join(' '))
      if (text) return { text, source: 'for' }
    }
  }
  // 2. aria-label / aria-labelledby
  const ariaLabel = cleanText(element.getAttribute('aria-label'))
  if (ariaLabel) return { text: ariaLabel, source: 'aria' }
  const root = element.getRootNode() as Document | ShadowRoot
  const ariaIds = element.getAttribute('aria-labelledby')?.split(/\s+/) || []
  const ariaText = cleanText(ariaIds.map(id => (root.getElementById?.(id))?.textContent || '').filter(Boolean).join(' '))
  if (ariaText) return { text: ariaText, source: 'aria' }
  // 3. 显式 label[for]（labels 属性对自定义控件可能不可用）
  if (element.id) {
    const associated = root.querySelector?.(`label[for="${CSS.escape(element.id)}"]`)
    const text = cleanText(associated?.textContent)
    if (text) return { text, source: 'for' }
  }
  const wrapped = element.closest('label')
  if (wrapped) {
    const text = cleanText(wrapped.textContent)
    if (text) return { text, source: 'for' }
  }
  // 4. 表单项容器内的 label 节点
  const formItem = element.closest(FORM_ITEM_SELECTOR)
  if (formItem) {
    const nearby = formItem.querySelector(FORM_ITEM_LABEL_SELECTOR)
    const text = cleanText(nearby?.textContent)
    if (text) return { text, source: 'container' }
  }
  // 5. 兄弟节点（弱）
  const parent = element.parentElement
  const sibling = element.previousElementSibling || parent?.previousElementSibling
  const siblingText = cleanText(sibling?.textContent)
  if (siblingText && siblingText.length < 80) return { text: siblingText, source: 'sibling' }
  // 6. placeholder / name（最弱）
  const placeholder = cleanText(element.getAttribute('placeholder'))
  if (placeholder) return { text: placeholder, source: 'placeholder' }
  const name = cleanText(element.getAttribute('name'))
  if (name) return { text: name, source: 'placeholder' }
  return { text: '', source: 'none' }
}

const CODE_VALUE = /^(0|1|true|false|yes|no|y|n)$/i

function shortOptionText(text: string): string {
  const cleaned = cleanText(text)
  if (!cleaned || cleaned.length > 40 || CODE_VALUE.test(cleaned)) return ''
  return cleaned
}

/** 下拉选项或单选被点中时的可见文字。题目和占位文案不算选项。 */
export function visibleChoiceText(element: HTMLElement): string {
  const title = shortOptionText(element.getAttribute('title') || '')
  if (title) return title
  const labelled = element.querySelector('.el-radio__label,.el-checkbox__label,.el-radio-button__inner,.ant-select-item-option-content,.el-select-dropdown__item span')
  const fromLabel = labelled ? shortOptionText(labelled.textContent || '') : ''
  if (fromLabel) return fromLabel
  return shortOptionText(element.textContent || '')
}

/**
 * 单个选项的文字（是 / 否、男 / 女）。
 * 很多表单把可见文字写在 label 或相邻节点上，input 的 value 却是 0、1。
 * 学习时必须用看得见的文字，不能把内部编码写进知识库。
 */
export function optionLabel(element: HTMLElement): string {
  const component = element.closest('.el-radio,.el-checkbox,.ant-radio-wrapper,.ant-radio-button-wrapper,.arco-radio,.el-radio-button')
  const explicit = component?.querySelector('.el-radio__label,.el-checkbox__label,.el-radio-button__inner')
  const explicitText = explicit ? shortOptionText(explicit.textContent || '') : ''
  if (explicitText) return explicitText

  if (element instanceof HTMLInputElement && element.labels?.length) {
    const labels = Array.from(element.labels)
    const crowded = labels.some(label => label.querySelectorAll('input[type="radio"],input[type="checkbox"]').length > 1)
    const text = shortOptionText(labels.map(label => label.textContent || '').join(' '))
    if (text && !crowded) return text
  }

  const wrapper = element.closest('.ant-radio-wrapper,.ant-radio-button-wrapper,.el-radio,.el-radio-button,.arco-radio,.ant-checkbox-wrapper,.el-checkbox,[role="radio"],[role="checkbox"],label')
  if (wrapper) {
    const inputs = wrapper.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"]')
    const text = shortOptionText(wrapper.textContent || '')
    if (text && inputs.length <= 1) return text
  }

  const sibling = element.nextElementSibling || element.previousElementSibling
  if (sibling && !(sibling instanceof HTMLInputElement) && !(sibling instanceof HTMLSelectElement)) {
    const text = shortOptionText(sibling.textContent || '')
    if (text && !sibling.querySelector('input,select,textarea')) return text
  }

  let parent = element.parentElement
  for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
    const inputs = parent.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"]')
    if (inputs.length > 1) break
    const text = shortOptionText(parent.textContent || '')
    if (text) return text
  }

  const aria = shortOptionText(element.getAttribute('aria-label') || '')
  if (aria) return aria
  if (element instanceof HTMLInputElement) {
    const value = element.value.trim()
    if (value && !CODE_VALUE.test(value)) return value
  }
  const own = shortOptionText(element.textContent || '')
  return own
}

/**
 * 选择题的题目（性别），而不是当前选项（男）。
 * 优先用表单项标签、legend、分组的 aria-label。
 */
export function questionLabel(element: HTMLElement): ResolvedLabel {
  const formItem = element.closest(FORM_ITEM_SELECTOR)
  const labelNode = formItem ? Array.from(formItem.querySelectorAll(FORM_ITEM_LABEL_SELECTOR)).find(node => !node.contains(element)) : undefined
  const labelText = cleanText(labelNode?.textContent)
  if (labelText && labelText.length < 80) return { text: labelText, source: 'container' }
  const group = element.closest(CHOICE_GROUP_SELECTOR)
  const legend = cleanText(group?.querySelector(':scope > legend')?.textContent)
  if (legend) return { text: legend, source: 'container' }
  const aria = cleanText(group?.getAttribute('aria-label'))
  if (aria) return { text: aria, source: 'aria' }
  const sibling = cleanText((group || element.parentElement)?.previousElementSibling?.textContent)
  if (sibling && sibling.length < 40) return { text: sibling, source: 'sibling' }
  return resolveLabel(element)
}

/** 字段附近的提示文字（表单项容器内除 label 与控件本身外的短文本），作为 nearbyText 信号。 */
export function resolveNearbyText(element: HTMLElement): string {
  const formItem = element.closest(FORM_ITEM_SELECTOR)
  if (!formItem) return ''
  const hints = Array.from(formItem.querySelectorAll('.help,.hint,.tip,.extra,.ant-form-item-extra,.el-form-item__description,small'))
    .map(node => cleanText(node.textContent))
    .filter(text => text && text.length < 100)
  return hints.join(' ').slice(0, 200)
}
