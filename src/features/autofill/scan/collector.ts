import type { FieldAttrs, FieldKind, FormField } from '../../../domain/types'
import { CUSTOM_SELECT_SELECTOR, detectFieldKind, getFieldOptions, isDateLikeControl, isSelectLikeControl } from '../fieldDetector'
import { optionLabel, questionLabel, questionText, resolveLabel, resolveNearbyText } from './labelResolver'
import { detectRepeatGroup } from './repeatGroups'
import { fieldFingerprint } from './fingerprint'
import { sectionOfText } from '../../ontology/sections'
import { isPlaceholderOption, looksLikeFieldPrompt, plainChoiceText } from '../../ontology/optionMatch'

/**
 * 控件收集（§4.1）：从旧 content.scan() 迁出。
 * - shadow DOM 穿透（F13）：递归进入 open shadow root。
 * - 字段 ID 改为稳定指纹（F15），重渲染后可重新定位。
 */

export const FIELD_SELECTOR = 'input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"],[contenteditable="true"]'

export interface FieldRef {
  kind: FieldKind
  element: HTMLElement
  radios?: HTMLInputElement[]
  checkboxes?: HTMLInputElement[]
  /** 不是 input 的选项，例如 role="radio" 的节点。 */
  choices?: HTMLElement[]
}

export interface ScanOutput {
  fields: FormField[]
  refs: Map<string, FieldRef>
}

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || !element.getClientRects().length) return false
  const style = getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

const CHOICE_WRAPPER = 'label,.ant-radio-wrapper,.ant-radio-button-wrapper,.el-radio,.el-radio-button,.arco-radio,.n-radio,.ivu-radio-wrapper,.van-radio,.t-radio,.semi-radio,.ant-checkbox-wrapper,.el-checkbox,[role="radio"],[role="checkbox"]'
const SPECIFIC_CHOICE_GROUP = '[role="radiogroup"],.ant-radio-group,.el-radio-group,.arco-radio-group,.n-radio-group,.ivu-radio-group,.van-radio-group,.t-radio-group,.semi-radio-group,.ant-checkbox-group,.el-checkbox-group'
const CUSTOM_RADIO_GROUP = '[role="radiogroup"],.ant-radio-group,.el-radio-group,.arco-radio-group,.n-radio-group,.ivu-radio-group,.van-radio-group,.t-radio-group,.semi-radio-group'
const CHOICE_MENU = `${CUSTOM_SELECT_SELECTOR},[role="listbox"],.ant-select-dropdown,.el-select-dropdown,.arco-select-dropdown,.semi-select-dropdown,.t-select__dropdown,[class*="select-dropdown"]`

/**
 * 组件库常把 radio / checkbox / select 的原生节点藏起来（display:none 或 0 尺寸），
 * 真正可见的是外层标签。这种控件仍然要识别、填写和学习。
 */
function present(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[data-resume-assistant]')) return false
  if (visible(element)) return true
  if (element instanceof HTMLInputElement && (element.type === 'radio' || element.type === 'checkbox')) {
    const host = (element.closest(CHOICE_WRAPPER) || element.parentElement) as HTMLElement | null
    return Boolean(host && host !== element && visible(host))
  }
  if (element instanceof HTMLSelectElement) {
    return Boolean(element.parentElement && visible(element.parentElement))
  }
  return false
}

function sameChoiceGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  if (a.type !== b.type) return false
  const groupA = a.closest(SPECIFIC_CHOICE_GROUP)
  const groupB = b.closest(SPECIFIC_CHOICE_GROUP)
  if (groupA || groupB) return groupA === groupB
  if (a.name && a.name === b.name && a.form === b.form) return true
  if (a.name || b.name) return false
  return a.parentElement != null && a.parentElement === b.parentElement
}

function classText(element: HTMLElement): string {
  return typeof element.className === 'string' ? element.className : ''
}

/** 选中样式。strict 时不把单独的 active 算进去，避免误伤图标。 */
function markedSelected(element: HTMLElement, strict = false): boolean {
  if (element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true') return true
  const className = classText(element)
  if (/(?:^|\s)(?:is-checked|is-active|checked|selected)(?:\s|$)/.test(className)) return true
  if (/(?:^|[\s_])[\w-]*is-checked(?:[\s_]|$)/.test(className)) return true
  if (/(?:radio|checkbox)[\w-]*(?:checked|active)/i.test(className)) return true
  return !strict && /(?:^|\s)active(?:\s|$)/.test(className)
}

/** 这一层里有几道单选/多选。外层 role 和里面的 input 算同一个。 */
function choiceCount(element: HTMLElement): number {
  const found = element.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')
  const seen = new Set<HTMLElement>()
  for (const node of found) {
    if (!(node instanceof HTMLElement)) continue
    const input = node.matches('input[type="radio"],input[type="checkbox"]')
      ? node
      : node.querySelector('input[type="radio"],input[type="checkbox"]')
    seen.add(input instanceof HTMLElement ? input : node)
  }
  return seen.size
}

function choiceNodes(ref: FieldRef): HTMLElement[] {
  if (ref.kind === 'checkbox') return [...(ref.checkboxes || []), ...(ref.choices || [])]
  return [...(ref.radios || []), ...(ref.choices || [])]
}

function choiceShell(node: HTMLElement): HTMLElement {
  return (node.closest(CHOICE_WRAPPER) || node.parentElement || node) as HTMLElement
}

/** 点在第二个选项的文字上时，分组祖先可能只包住第一个选项。选项自己的外层仍算这道题。 */
function targetInChoice(target: HTMLElement, nodes: HTMLElement[]): boolean {
  return nodes.some(item => {
    if (item === target || item.contains(target) || target.contains(item)) return true
    const shell = choiceShell(item)
    return shell === target || shell.contains(target) || target.contains(shell)
  })
}

/**
 * 捕获阶段的 event.target 在开放 Shadow 里会变成宿主。
 * composedPath 的第一个元素才是真正点中的节点。
 */
export function eventElement(event: Event): HTMLElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node instanceof HTMLElement) return node
  }
  return event.target instanceof HTMLElement ? event.target : null
}

const CHOICE_CLICK = 'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],label'

/** 点在单选/多选样子的节点上。这类点击对不上字段时要重扫，不能只重扫 input 和 select。 */
export function looksLikeChoice(element: HTMLElement): boolean {
  if (element.closest(CHOICE_CLICK)) return true
  let node: HTMLElement | null = element
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    const className = typeof node.className === 'string' ? node.className : ''
    if (/radio|checkbox/i.test(className)) return true
  }
  return false
}

/** 每个选项的外层。公共祖先里还有别的题时，不能只观察第一个选项的父节点。 */
export function choiceObserveRoots(ref: FieldRef): HTMLElement[] {
  const roots = new Set<HTMLElement>()
  for (const node of choiceNodes(ref)) {
    const shell = choiceShell(node)
    if (shell === document.body || shell === document.documentElement) continue
    roots.add(shell)
  }
  return [...roots]
}

/** 包住这道题全部选项、且不把别的题包进来的那一层。 */
export function choiceGroupOf(ref: FieldRef): HTMLElement | null {
  const nodes = choiceNodes(ref)
  if (!nodes.length) return null
  let node: HTMLElement | null = nodes[0]
  while (node && !nodes.every(item => node === item || node!.contains(item))) node = node.parentElement
  if (!node || node === document.body || node === document.documentElement) return nodes[0].parentElement
  const inputs = node.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')
  const foreign = Array.from(inputs).some(input => input instanceof HTMLElement
    && !nodes.includes(input)
    && !nodes.some(item => item.contains(input) || input.contains(item)))
  if (foreign) return nodes[0].parentElement
  return node
}

function plainText(element: HTMLElement): string {
  return (element.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 选项读出来只有 0、1、2 这种内部编码时，不能拿它覆盖看得见的文字。 */
function codedLabels(options: string[]): boolean {
  return !options.length || options.every(option => /^[\d.]+$/.test(option) || /^(true|false|yes|no|y|n)$/i.test(option))
}

/** 只看外层样式，不看 input.checked。组件库经常只改 class，原生选中状态是旧的。 */
function visuallySelected(element: HTMLElement): boolean {
  let node: HTMLElement | null = element
  let host = element
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    if (node !== element && choiceCount(node) > 1) break
    host = node
    if (markedSelected(node)) return true
  }
  return Array.from(host.querySelectorAll<HTMLElement>('*')).some(child => choiceCount(child) === 0 && markedSelected(child, true))
}

/**
 * 点在选项文字上时，返回这个选项的可见文字。
 * 文字和 input 经常是兄弟节点，不能只认包住 input 的 label。
 */
export function readClickedChoice(target: HTMLElement, ref: FieldRef): string {
  if (ref.kind !== 'radio' && ref.kind !== 'checkbox') return ''
  const nodes = choiceNodes(ref)
  const options = nodes.map(optionLabel).filter(Boolean)
  const group = choiceGroupOf(ref)
  if (group && group !== target && !group.contains(target) && !targetInChoice(target, nodes)) return ''
  let node: HTMLElement | null = target
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    const current = node
    if (choiceCount(current) > 1) break
    const text = plainText(current)
    const owned = nodes.find(item => item === current || current.contains(item) || item.contains(current))
    const textHit = Boolean(text && text.length <= 40 && !isPlaceholderOption(text) && (options.includes(text) || codedLabels(options)))
    if (textHit) {
      const hostInput = current.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')
      if (hostInput instanceof HTMLElement && !nodes.includes(hostInput) && !nodes.some(item => item.contains(hostInput) || hostInput.contains(item))) return ''
      if (!hostInput && current.parentElement) {
        const around = Array.from(current.parentElement.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]'))
        const foreign = around.some(input => input instanceof HTMLElement && !nodes.includes(input) && !nodes.some(item => item.contains(input)))
        if (foreign) continue
      }
      return plainChoiceText(text)
    }
    if (owned) {
      const label = optionLabel(owned)
      if (label) return label
    }
  }
  return ''
}

/** 选中样式在选项文字上、不在 input 上时，用和选项一致的那段文字。 */
function markedOptionText(ref: FieldRef, nodes: HTMLElement[]): string {
  const options = nodes.map(optionLabel).filter(Boolean)
  const group = choiceGroupOf(ref)
  if (!group) return ''
  const texts = new Set<string>()
  for (const node of group.querySelectorAll<HTMLElement>('*')) {
    if (choiceCount(node) > 0 || !markedSelected(node)) continue
    const text = plainText(node)
    if (!text || text.length > 40 || isPlaceholderOption(text)) continue
    if (options.includes(text) || codedLabels(options)) texts.add(text)
  }
  return texts.size === 1 ? plainChoiceText([...texts][0]) : ''
}

function choiceSelected(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.checked) return true
  if (element.getAttribute('aria-checked') === 'true') return true
  return visuallySelected(element)
}

/** 组件库下拉框展示的是选中项文字。打开时搜索框里的半截输入不能当成已选值。 */
const SELECTION_ITEM = '.ant-select-selection-item,.ant-select-selection-selected-value,.el-select__selected-item,.el-select__tags-text,.arco-select-view-value,.n-base-selection-label,.ivu-select-selected-value,.semi-select-selection-text,.t-tag,.t-select__single'
const SEARCH_INPUT = '.ant-select-selection-search-input,.ant-select-search__field,.el-select__input'

function isSearchInput(input: HTMLInputElement): boolean {
  return input.matches(SEARCH_INPUT) || input.getAttribute('aria-autocomplete') === 'list'
}

function committedText(node: HTMLElement, placeholder = ''): string {
  const title = plainChoiceText(node.getAttribute('title') || '')
  if (title && title.length <= 40 && !isPlaceholderOption(title) && !looksLikeFieldPrompt(title) && title !== placeholder) return title
  if (node.closest('.ant-select-selection-placeholder,.el-select__placeholder')) return ''
  const text = plainChoiceText(node.textContent || '')
  if (!text || text.length > 40 || isPlaceholderOption(text) || looksLikeFieldPrompt(text) || text === placeholder) return ''
  return text
}

function displayedSelection(element: HTMLElement): string {
  const host = element.closest(CUSTOM_SELECT_SELECTOR) || element
  const input = host instanceof HTMLInputElement ? host : host.querySelector<HTMLInputElement>('input:not([type="hidden"])')
  const placeholder = (input?.getAttribute('placeholder') || host.getAttribute('placeholder') || '').trim()
  const shown = Array.from(host.querySelectorAll<HTMLElement>(SELECTION_ITEM)).map(node => committedText(node, placeholder)).find(Boolean) || ''
  if (shown) return shown
  if (!input || isSearchInput(input)) return ''
  const value = input.value.trim()
  if (!value || value === placeholder || value.length > 40 || looksLikeFieldPrompt(value)) return ''
  return value
}

/** 下拉框包在 label 里时，标签全文会带上所有选项，学习时会被当成无效字段丢掉。 */
function controlLabel(element: HTMLElement, kind: FieldKind): ReturnType<typeof resolveLabel> {
  const asked = kind === 'radio' || kind === 'checkbox' || kind === 'select' || kind === 'multiselect' || kind === 'combobox' || kind === 'cascade'
    ? questionLabel(element)
    : resolveLabel(element)
  if ((kind === 'select' || kind === 'multiselect') && element instanceof HTMLSelectElement) {
    let text = asked.text
    for (const option of Array.from(element.options)) {
      const name = option.text.trim()
      if (name) text = text.split(name).join(' ')
    }
    text = text.replace(/[*＊:：]/g, ' ').replace(/\s+/g, ' ').trim()
    if (text && text.length <= 40 && !isPlaceholderOption(text)) return { text, source: asked.source }
  }
  const text = questionText(asked.text, [])
  if (text && text.length <= 40 && !looksLikeFieldPrompt(text)) return { text, source: asked.source }
  if (text.length > 40) return { text: text.slice(0, 40).trim(), source: asked.source }
  return { text: '', source: asked.source }
}

/** 递归收集候选控件，穿透 open shadow root。 */
export function collectCandidates(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = []
  const walk = (scope: ParentNode) => {
    for (const element of Array.from(scope.querySelectorAll<HTMLElement>(FIELD_SELECTOR))) out.push(element)
    for (const host of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
      if (host.shadowRoot) walk(host.shadowRoot)
    }
  }
  walk(root)
  return out
}

const SECTION_HEADING = ':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > legend,:scope > [role="heading"],:scope > .ant-card-head,:scope > .el-card__header,:scope > [class*="title"],:scope > [class*="header"]'

function compactText(element: HTMLElement): string {
  return (element.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 只取不含控件的短文字，避免把整块表单的正文当成板块标题。 */
function titleOnlyText(element: HTMLElement): string {
  if (element.querySelector(FIELD_SELECTOR)) return ''
  const text = compactText(element)
  if (!text || text.length >= 40) return ''
  return text
}

/**
 * 离控件最近的、能对上已知板块的标题。
 * 网申页常把「教育经历」放在表单块前面，不包在 fieldset / card 里。
 */
export function sectionHeadingOf(element: HTMLElement): string {
  let node: HTMLElement | null = element.parentElement
  for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
    let sibling: Element | null = node.previousElementSibling
    for (let index = 0; sibling && index < 6; index += 1, sibling = sibling.previousElementSibling) {
      if (!(sibling instanceof HTMLElement)) continue
      const text = titleOnlyText(sibling)
      if (text && sectionOfText(text)) return text
    }
    const aria = (node.getAttribute('aria-label') || '').trim()
    if (aria.length > 0 && aria.length < 40 && sectionOfText(aria)) return aria
    const heading = node.querySelector(SECTION_HEADING)
    if (heading instanceof HTMLElement) {
      const text = titleOnlyText(heading)
      if (text && sectionOfText(text)) return text
    }
  }
  return ''
}

/** 区块标题判定（从旧 groupOf 迁出，与重复段信息拼接）。 */
function groupOf(element: HTMLElement, repeatItem?: number): string {
  const repeatedSuffix = repeatItem && repeatItem > 0 ? ` 第${repeatItem}段` : ''
  const known = sectionHeadingOf(element)
  if (known) return `${known}${repeatedSuffix}`
  let node: HTMLElement | null = element.parentElement
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    if (node.matches('fieldset,section,[role="group"],.ant-card,.el-card,.arco-card,[class*="section"],[class*="panel"]')) {
      const heading = node.querySelector<HTMLElement>(SECTION_HEADING)
      const text = (heading ? compactText(heading) : '') || (node.getAttribute('aria-label') || '').trim()
      if (text && text.length < 80) return `${text}${repeatedSuffix}`
    }
  }
  return repeatedSuffix ? `重复经历${repeatedSuffix}` : ''
}

function currentValue(ref: FieldRef): string {
  const { element, kind } = ref
  if (kind === 'radio') {
    const nodes = [...(ref.radios || []), ...(ref.choices || [])]
    const painted = nodes.filter(visuallySelected)
    const native = nodes.filter(node => (node instanceof HTMLInputElement && node.checked) || node.getAttribute('aria-checked') === 'true')
    // 只有一个选项带着选中样式时，以样式为准。原生 checked 可能还停在上一个选项。
    const selected = painted.length === 1
      ? painted[0]
      : native.length === 1
        ? native[0]
        : painted.find(node => native.includes(node)) || native[0] || painted[0]
    const fromNode = selected ? optionLabel(selected) : ''
    const marked = markedOptionText(ref, nodes)
    if (painted.length === 1 && fromNode && !codedLabels([fromNode])) return fromNode
    if (marked) return marked
    return fromNode
  }
  if (kind === 'checkbox') {
    const checkboxes = ref.checkboxes || [element as HTMLInputElement]
    if (checkboxes.length === 1 && !ref.choices?.length) return checkboxes[0].checked ? '是' : ''
    return checkboxes.filter(checkbox => checkbox.checked).map(checkbox => optionLabel(checkbox) || checkbox.value).join('、')
  }
  if (element instanceof HTMLSelectElement) {
    // 不用 selectedOptions：其 live 集合在部分环境（含 jsdom）对 selectedIndex 变更不失效
    const selected = Array.from(element.options)
      .filter(option => option.selected)
      .map(option => plainChoiceText(option.text))
      .filter(option => option && !isPlaceholderOption(option) && !looksLikeFieldPrompt(option))
    return selected.join('、')
  }
  if (kind === 'combobox' || kind === 'cascade') return displayedSelection(element)
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const value = element.value.trim()
    const placeholder = element.placeholder.trim()
    if (!value || value === placeholder || looksLikeFieldPrompt(value)) return ''
    return value
  }
  const text = element.textContent?.replace(/\s+/g, ' ').trim() || ''
  if (!text || text === element.getAttribute('placeholder')?.trim() || looksLikeFieldPrompt(text)) return ''
  return text
}

function attrsOf(element: HTMLElement): FieldAttrs {
  return {
    name: element.getAttribute('name') || undefined,
    id: element.id || undefined,
    autocomplete: element.getAttribute('autocomplete') || undefined,
    type: element.getAttribute('type') || undefined,
    inputmode: element.getAttribute('inputmode') || undefined
  }
}

/**
 * 扫描页面，产出携带指纹与打分信号的字段列表。
 * 槽位打分由调用方（content 编排层）在此结果上追加。
 */
export function scanPage(root: Document | ShadowRoot = document): ScanOutput {
  const refs = new Map<string, FieldRef>()
  const fields: FormField[] = []
  const radiosSeen = new Set<string>()
  const checkboxesSeen = new Set<string>()
  const selectHosts = new Set<HTMLElement>()
  const usedIds = new Set<string>()
  const groupIds = new WeakMap<Element, string>()
  let groupSeq = 0

  const groupKey = (element: Element) => {
    const existing = groupIds.get(element)
    if (existing) return existing
    const next = `g${groupSeq += 1}`
    groupIds.set(element, next)
    return next
  }

  const addField = (element: HTMLElement, kind: FieldKind, extras: { radios?: HTMLInputElement[]; checkboxes?: HTMLInputElement[]; choices?: HTMLElement[] } = {}) => {
    const choice = kind === 'radio' || kind === 'checkbox'
    const resolved = choice ? questionLabel(element) : controlLabel(element, kind)
    const options = extras.choices?.map(optionLabel).filter(Boolean) || getFieldOptions(kind, element, extras.radios, extras.checkboxes)
    const labelText = questionText(resolved.text, options)
    const repeat = detectRepeatGroup(element)
    const group = groupOf(element, repeat?.item)
    const sectionId = sectionOfText(group) || undefined
    const ref: FieldRef = { kind, element, ...extras }
    let fingerprint = fieldFingerprint({ element, label: labelText, kind, repeatIndex: repeat?.item, sectionId })
    while (usedIds.has(fingerprint)) fingerprint = `${fingerprint}+`
    usedIds.add(fingerprint)
    refs.set(fingerprint, ref)
    const placeholderHost = element.matches('input,textarea') ? element : element.querySelector('input[placeholder],textarea[placeholder]')
    fields.push({
      id: fingerprint,
      fingerprint,
      label: labelText,
      labelSource: resolved.source,
      group,
      sectionId,
      placeholder: placeholderHost?.getAttribute('placeholder')?.trim() || '',
      kind,
      options,
      current: currentValue(ref),
      required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      maxLength: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? Math.max(0, element.maxLength) : 0,
      range: Boolean(element.closest('.ant-picker-range,.el-range-editor,.el-date-editor--daterange,.el-date-editor--monthrange')),
      name: element.getAttribute('name') || undefined,
      item: repeat?.item,
      repeatGroupId: repeat?.repeatGroupId,
      attrs: attrsOf(element),
      nearbyText: resolveNearbyText(element) || undefined
    })
  }

  for (const element of collectCandidates(root)) {
    if (element.closest('[data-resume-assistant]')) continue
    const selectHost = element.closest(CUSTOM_SELECT_SELECTOR) as HTMLElement | null
    if (selectHost) {
      if (selectHosts.has(selectHost) || !visible(selectHost)) continue
      selectHosts.add(selectHost)
      const resolved = resolveLabel(selectHost)
      const kind = detectFieldKind(selectHost, resolved.text, groupOf(selectHost))
      addField(selectHost, kind === 'cascade' || kind === 'date' || kind === 'multiselect' ? kind : 'combobox')
      continue
    }
    if (element instanceof HTMLInputElement && element.type === 'file') {
      if (!element.disabled) addField(element, 'file')
      continue
    }
    if (!present(element)) continue
    if (element instanceof HTMLInputElement) {
      const customControl = element.getAttribute('role') === 'combobox' || isDateLikeControl(element) || isSelectLikeControl(element) || Boolean(element.closest('.ant-cascader'))
      if (['hidden', 'password', 'file', 'submit', 'reset', 'button', 'image'].includes(element.type) || element.disabled || (element.readOnly && !customControl)) continue
    }
    if (element instanceof HTMLTextAreaElement && (element.disabled || element.readOnly)) continue
    if (element instanceof HTMLSelectElement && element.disabled) continue
    if (element.matches('[role="combobox"]') && element.querySelector('input')) continue

    const resolved = resolveLabel(element)
    const group = groupOf(element)
    const kind = detectFieldKind(element, resolved.text, group)

    let radios: HTMLInputElement[] | undefined
    let checkboxes: HTMLInputElement[] | undefined
    if (kind === 'radio' && element instanceof HTMLInputElement) {
      const specific = element.closest(SPECIFIC_CHOICE_GROUP)
      const key = specific
        ? `group:${groupKey(specific)}`
        : element.name
          ? `name:${element.form ? groupKey(element.form) : 'noform'}:${element.name}`
          : `parent:${element.parentElement ? groupKey(element.parentElement) : groupKey(element)}`
      if (radiosSeen.has(key)) continue
      radiosSeen.add(key)
      radios = collectCandidates(root)
        .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio')
        .filter(radio => present(radio) && sameChoiceGroup(radio, element))
    }
    if (kind === 'checkbox' && element instanceof HTMLInputElement) {
      const specific = element.closest(SPECIFIC_CHOICE_GROUP)
      const key = specific
        ? `group:${groupKey(specific)}`
        : element.name
          ? `name:${element.form ? groupKey(element.form) : 'noform'}:${element.name}`
          : `parent:${element.parentElement ? groupKey(element.parentElement) : groupKey(element)}`
      if (checkboxesSeen.has(key)) continue
      checkboxesSeen.add(key)
      checkboxes = collectCandidates(root)
        .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'checkbox')
        .filter(checkbox => present(checkbox) && sameChoiceGroup(checkbox, element))
    }

    addField(element, kind, { radios, checkboxes })
  }

  collectCustomRadios(root, addField)

  return { fields, refs }
}

function forEachScope(root: ParentNode, visit: (scope: ParentNode) => void): void {
  visit(root)
  if (!('querySelectorAll' in root)) return
  for (const host of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (host.shadowRoot) forEachScope(host.shadowRoot, visit)
  }
}

function classTextOf(element: HTMLElement): string {
  return typeof element.className === 'string' ? element.className : ''
}

/** 自绘选项：class 像 radio / option，且不是下拉弹层里的项。 */
function isCustomChoiceOption(element: HTMLElement): boolean {
  if (element.closest(CHOICE_MENU)) return false
  const tokens = classTextOf(element).split(/[\s_]+/).filter(Boolean)
  return tokens.some(token => {
    if (/radio-group|checkbox-group|select-option/i.test(token)) return false
    if (/radio|checkbox/i.test(token)) return true
    return /^(opt|option)$/i.test(token) || (/(?:^|-)option$/i.test(token) && !/select/i.test(token))
  })
}

function labeledChoices(choices: HTMLElement[]): HTMLElement[] {
  return choices.filter(choice => optionLabel(choice))
}

/**
 * 没有原生 input 的单选。
 * role="radio" 按父级成组；组件库分组和 class 像选项的节点同样收进来。
 */
function collectCustomRadios(root: ParentNode, addField: (element: HTMLElement, kind: 'radio', extras: { choices: HTMLElement[] }) => void): void {
  const claimed = new Set<HTMLElement>()
  const claim = (choices: HTMLElement[]) => choices.forEach(choice => claimed.add(choice))
  const taken = (element: HTMLElement) => claimed.has(element) || [...claimed].some(owner => owner.contains(element))

  forEachScope(root, scope => {
    for (const group of Array.from(scope.querySelectorAll<HTMLElement>(CUSTOM_RADIO_GROUP))) {
      if (!visible(group) || group.querySelector('input[type="radio"]')) continue
      const choices = labeledChoices(Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter(choice => visible(choice) && !taken(choice)))
      if (choices.length < 2) continue
      claim(choices)
      addField(group, 'radio', { choices })
    }

    const byParent = new Map<HTMLElement, HTMLElement[]>()
    for (const choice of Array.from(scope.querySelectorAll<HTMLElement>('[role="radio"]'))) {
      if (!visible(choice) || taken(choice) || choice.querySelector('input[type="radio"]')) continue
      const parent = choice.parentElement
      if (!parent || !visible(parent) || parent.querySelector('input[type="radio"]')) continue
      const list = byParent.get(parent) || []
      list.push(choice)
      byParent.set(parent, list)
    }
    for (const [parent, grouped] of byParent) {
      const choices = labeledChoices(grouped.filter(choice => !taken(choice)))
      if (choices.length < 2) continue
      claim(choices)
      addField(parent, 'radio', { choices })
    }

    const classed = new Map<HTMLElement, HTMLElement[]>()
    for (const choice of Array.from(scope.querySelectorAll<HTMLElement>('[class*="radio"],[class*="option"],[class*="opt"]'))) {
      if (!visible(choice) || taken(choice) || !isCustomChoiceOption(choice)) continue
      if (choice.querySelector('input,select,textarea,[role="radio"],[role="checkbox"]')) continue
      const parent = choice.parentElement
      if (!parent || !visible(parent) || parent.querySelector('input[type="radio"]')) continue
      const list = classed.get(parent) || []
      list.push(choice)
      classed.set(parent, list)
    }
    for (const [parent, grouped] of classed) {
      const leaves = grouped.filter(choice => !grouped.some(other => other !== choice && choice.contains(other)))
      const choices = labeledChoices(leaves.filter(choice => !taken(choice)))
      if (choices.length < 2) continue
      claim(choices)
      addField(parent, 'radio', { choices })
    }
  })
}

/** 供写入层回读当前值使用。 */
export function readCurrentValue(ref: FieldRef): string {
  return currentValue(ref)
}
