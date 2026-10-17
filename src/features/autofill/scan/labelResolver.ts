import type { LabelSource } from '../../../domain/types'
import { looksLikeFieldPrompt, plainChoiceText } from '../../ontology/optionMatch'
import { sectionOfText } from '../../ontology/sections'
import {
  PLATFORM_CHOICE_WRAPPER_SELECTOR,
  PLATFORM_FORM_ITEM_SELECTOR,
  PLATFORM_LABEL_SELECTOR,
  PLATFORM_RADIO_GROUP_SELECTOR,
  PLATFORM_CHECKBOX_GROUP_SELECTOR,
  PLATFORM_OPTION_SELECTOR
} from '../platforms/registry'

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
const FORM_ITEM_SELECTOR = ['.ant-form-item,.el-form-item,.arco-form-item,.n-form-item,.ivu-form-item,.form-group,.form-item,.field,[data-field]', PLATFORM_FORM_ITEM_SELECTOR].filter(Boolean).join(',')
const FORM_ITEM_LABEL_SELECTOR = ['label,.ant-form-item-label,.el-form-item__label,.arco-form-item-label,.n-form-item-label,.ivu-form-item-label,legend,.label', PLATFORM_LABEL_SELECTOR].filter(Boolean).join(',')
const CHOICE_GROUP_SELECTOR = ['[role="radiogroup"],[role="group"],.ant-radio-group,.el-radio-group,.arco-radio-group,.ant-checkbox-group,.el-checkbox-group,fieldset', PLATFORM_RADIO_GROUP_SELECTOR, PLATFORM_CHECKBOX_GROUP_SELECTOR].filter(Boolean).join(',')

function cleanText(text: string | null | undefined): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    // 必填符既可能放在标签末尾（姓名 *），也可能像多数中文表单一样放在开头（* 姓名）。
    // 在标签进入指纹、站点规则和槽位匹配前统一剥离，避免各下游各自猜测。
    .replace(/^(?:[*＊]\s*)+(?:[:：]\s*)?/, '')
    .replace(/(?:\s*[*＊:：])+\s*$/, '')
    .trim()
}

/** basicSex、srcPlace 这种标识符不是给人看的字段名。 */
export function isFieldIdentifier(text: string): boolean {
  return /^[A-Za-z_][\w.-]*$/.test(text.trim())
}

function hasControl(element: HTMLElement): boolean {
  return Boolean(element.querySelector('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"],[role="radio"],[role="checkbox"],[contenteditable="true"]'))
}

/** 不含控件的短标题。带输入框的上一整行不能拿来当这一行的字段名。 */
function labelOnlyText(element: HTMLElement): string {
  if (element.matches('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"],[contenteditable="true"]') || hasControl(element)) return ''
  const text = cleanText(element.textContent)
  if (!text || text.length > 40 || looksLikeFieldPrompt(text) || isFieldIdentifier(text) || sectionOfText(text)) return ''
  return text
}

/**
 * 中文标题常常在输入框外层的前一个兄弟上，而不是直接挨着 input。
 * 只接受没有控件的短文字，避免把上一题的「性别 男 女」整段借过来。
 */
export function nearbyLabel(element: HTMLElement): string {
  let node: HTMLElement | null = element
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    let sibling: Element | null = node.previousElementSibling
    for (let index = 0; sibling && index < 3; index += 1, sibling = sibling.previousElementSibling) {
      if (!(sibling instanceof HTMLElement)) continue
      const text = labelOnlyText(sibling)
      if (text) return text
    }
  }
  return ''
}

const PROMPT_PREFIX = /^(请选择|请输入|请填写|请搜索|选择或搜索|搜索或选择|点击选择)/

/**
 * 有的网站没有旁边的标题，字段名写在 placeholder 里。
 * 「请选择性别」→「性别」，「选择或搜索生源（户籍）地」→「生源地」，「健康状况」保持原样。
 * 剥完只剩提示语时返回空，避免把占位句本身当成字段名。
 */
export function labelFromPlaceholder(raw: string): string {
  let text = cleanText(raw)
  if (!text || isFieldIdentifier(text)) return ''
  text = cleanText(text.replace(PROMPT_PREFIX, ''))
  text = cleanText(text.replace(/[（(][^）)]*[）)]/g, ''))
  if (!text || text.length > 40 || looksLikeFieldPrompt(text) || isFieldIdentifier(text)) return ''
  return text
}

function acceptLabel(text: string, source: LabelSource): ResolvedLabel | null {
  const cleaned = cleanText(text)
  if (!cleaned) return null
  const named = looksLikeFieldPrompt(cleaned) || isFieldIdentifier(cleaned) ? labelFromPlaceholder(cleaned) : cleaned
  if (!named || isFieldIdentifier(named) || looksLikeFieldPrompt(named)) return null
  return { text: named, source }
}

/** 有些组件把 .form-item-control 也命名为 form-item；向上找到真正带题目标签的表单项。 */
function formItemLabel(element: HTMLElement): { item: HTMLElement; label: HTMLElement } | null {
  for (let item = element.closest<HTMLElement>(FORM_ITEM_SELECTOR); item; item = item.parentElement?.closest<HTMLElement>(FORM_ITEM_SELECTOR) || null) {
    const label = Array.from(item.querySelectorAll<HTMLElement>(FORM_ITEM_LABEL_SELECTOR))
      .find(node => !node.contains(element)
        && !node.closest('select,[role="combobox"]')
        && !(node instanceof HTMLLabelElement && node.control && node.control !== element && !element.contains(node.control)))
    if (label) return { item, label }
  }
  return null
}

/** 没有组件库 class 的普通行：一个题目标签同时包着前置选择框和后续输入框。 */
function plainCompoundItem(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  for (let depth = 0; parent && parent !== document.body && depth < 4; depth += 1, parent = parent.parentElement) {
    const labels = Array.from(parent.querySelectorAll('label'))
      .filter(label => !label.contains(element) && !label.closest('select,[role="combobox"]'))
    const controls = parent.querySelectorAll('input,textarea,select,[role="combobox"]')
    if (labels.length === 1 && controls.length <= 3) return parent
  }
  return null
}

/**
 * 题目被选项粘在一起时只留题目。
 * 「性别 男 女 性别男女」→「性别」，「是否为学生干部 否 是」→「是否为学生干部」。
 */
export function questionText(text: string, options: string[]): string {
  const compact = cleanText(text)
  if (!compact) return ''
  const tokens = options.map(option => cleanText(option)).filter(option => option.length > 0)
  for (const option of [...tokens].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?:^|[\\s/|、])${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s/|、])`)
    const match = pattern.exec(compact)
    if (!match || match.index <= 0) continue
    const head = cleanText(compact.slice(0, match.index))
    if (head && !looksLikeFieldPrompt(head) && !isFieldIdentifier(head)) return head
  }
  const flat = compact.replace(/\s+/g, '')
  const glued = tokens.join('')
  if (glued.length > 1) {
    const index = flat.indexOf(glued)
    if (index > 0) return flat.slice(0, index)
  }
  return compact
}

export function resolveLabel(element: HTMLElement): ResolvedLabel {
  // 1. label[for] / 包裹型 label（最强）
  if ('labels' in element) {
    const labels = (element as HTMLInputElement).labels
    if (labels?.length) {
      const accepted = acceptLabel(Array.from(labels).map(label => label.textContent || '').join(' '), 'for')
      if (accepted) return accepted
    }
  }
  // 2. aria-label / aria-labelledby
  const root = element.getRootNode() as Document | ShadowRoot
  const ariaLabel = acceptLabel(element.getAttribute('aria-label') || '', 'aria')
  if (ariaLabel) return ariaLabel
  const ariaIds = element.getAttribute('aria-labelledby')?.split(/\s+/) || []
  const ariaText = acceptLabel(ariaIds.map(id => (root.getElementById?.(id))?.textContent || '').filter(Boolean).join(' '), 'aria')
  if (ariaText) return ariaText
  // 3. 显式 label[for]（labels 属性对自定义控件可能不可用）
  if (element.id) {
    const associated = root.querySelector?.(`label[for="${CSS.escape(element.id)}"]`)
    const accepted = acceptLabel(associated?.textContent || '', 'for')
    if (accepted) return accepted
  }
  const wrapped = element.closest('label')
  if (wrapped) {
    const accepted = acceptLabel(wrapped.textContent || '', 'for')
    if (accepted) return accepted
  }
  // 4. 表单项容器内的 label 节点
  const formItem = formItemLabel(element)
  if (formItem) {
    const accepted = acceptLabel(formItem.label.textContent || '', 'container')
    if (accepted) return accepted
  }
  // 5. 往上找不含控件的短标题（中文 label 常在再外一层）
  const nearby = nearbyLabel(element)
  if (nearby) return { text: nearby, source: 'sibling' }
  // 6. 没有旁边的标题时，从 placeholder 里取出字段名。整句提示不原样留下。
  const own = element.getAttribute('placeholder') || ''
  const nested = element.querySelector('input[placeholder],textarea[placeholder]')?.getAttribute('placeholder') || ''
  const fromPlaceholder = labelFromPlaceholder(own || nested)
  if (fromPlaceholder) return { text: fromPlaceholder, source: 'placeholder' }
  return { text: '', source: 'none' }
}

const CODE_VALUE = /^(0|1|true|false|yes|no|y|n)$/i

function shortOptionText(text: string): string {
  const cleaned = plainChoiceText(cleanText(text))
  if (!cleaned || cleaned.length > 40 || CODE_VALUE.test(cleaned)) return ''
  return cleaned
}

/** 下拉选项或单选被点中时的可见文字。题目和占位文案不算选项。 */
export function visibleChoiceText(element: HTMLElement): string {
  const title = shortOptionText(element.getAttribute('title') || '')
  if (title) return title
  const labelled = element.querySelector(['.el-radio__label,.el-checkbox__label,.el-radio-button__inner,.ant-select-item-option-content,.el-select-dropdown__item span', PLATFORM_OPTION_SELECTOR].filter(Boolean).join(','))
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
  const component = element.closest(['.el-radio,.el-checkbox,.ant-radio-wrapper,.ant-radio-button-wrapper,.arco-radio,.el-radio-button', PLATFORM_CHOICE_WRAPPER_SELECTOR].filter(Boolean).join(','))
  const explicit = component?.querySelector('.el-radio__label,.el-checkbox__label,.el-radio-button__inner')
  const explicitText = explicit ? shortOptionText(explicit.textContent || '') : ''
  if (explicitText) return explicitText

  if (element instanceof HTMLInputElement && element.labels?.length) {
    const labels = Array.from(element.labels)
    const crowded = labels.some(label => label.querySelectorAll('input[type="radio"],input[type="checkbox"]').length > 1)
    const text = shortOptionText(labels.map(label => label.textContent || '').join(' '))
    if (text && !crowded) return text
  }

  const wrapper = element.closest(['.ant-radio-wrapper,.ant-radio-button-wrapper,.el-radio,.el-radio-button,.arco-radio,.ant-checkbox-wrapper,.el-checkbox,[role="radio"],[role="checkbox"],label', PLATFORM_CHOICE_WRAPPER_SELECTOR].filter(Boolean).join(','))
  if (wrapper) {
    const inputs = wrapper.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"]')
    const text = shortOptionText(wrapper.textContent || '')
    if (text && inputs.length <= 1) return text
  }

  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement)) {
    const own = shortOptionText(element.textContent || '')
    if (own && !element.querySelector('input,select,textarea,[role="radio"],[role="checkbox"]')) return own
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
export function questionLabel(element: HTMLElement, leadingChoice = false): ResolvedLabel {
  const formItem = formItemLabel(element)
  const sharedItem = formItem?.item || (leadingChoice ? plainCompoundItem(element) : null)
  if (leadingChoice && sharedItem) {
    const own = resolveLabel(element)
    if (own.source === 'for' || own.source === 'aria') return own
    const hasFollowingInput = Array.from(sharedItem.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea'))
      .some(input => !element.contains(input) && input !== element
        && !['hidden', 'radio', 'checkbox'].includes(input.type)
        && Boolean(element.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
    // 一个标题覆盖“前置选项 + 后续输入”时，它命名的是整道题，不能据此把选项值归为输入值。
    if (hasFollowingInput) return { text: '', source: 'none' }
  }
  const labelText = cleanText(formItem?.label.textContent)
  if (labelText && labelText.length < 80) return { text: labelText, source: 'container' }
  const group = element.closest(CHOICE_GROUP_SELECTOR)
  const legend = cleanText(group?.querySelector(':scope > legend')?.textContent)
  if (legend) return { text: legend, source: 'container' }
  const aria = cleanText(group?.getAttribute('aria-label'))
  if (aria) return { text: aria, source: 'aria' }
  const siblingNode = (group || element.parentElement)?.previousElementSibling
  const sibling = siblingNode instanceof HTMLElement ? labelOnlyText(siblingNode) : ''
  if (sibling) return { text: sibling, source: 'sibling' }
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
