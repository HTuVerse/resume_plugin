import type { FillReasonCode, FillRequest } from '../../../domain/types'
import type { FieldRef } from '../scan/collector'
import { readCurrentValue } from '../scan/collector'
import { isPlaceholderOption, matchOption, plainChoiceText } from '../../ontology/optionMatch'
import { booleanValue } from '../../ontology/synonyms'
import { isOngoingDate, normalizeDateValue, splitOngoingRange } from '../../ontology/validators'
import { optionLabel } from '../scan/labelResolver'
import { dispatchFieldEvents, isElementVisible, pollUntil, setNativeChecked, setNativeSelect, setNativeText, wait } from './domUtils'
import { popupOptions, visiblePopupFor, watchForPopup } from './popupLocator'
import { trustedClickElement, trustedReplaceText, trustedScrollElement } from './trustedInput'
import type { ControlCapabilities } from '../control/model'
import { projectOptionFromValue } from '../valueProjection'
import { PLATFORM_CONTROL_HOST_SELECTOR, PLATFORM_DATE_SELECTOR, PLATFORM_RANGE_SELECTOR, PLATFORM_SEARCH_INPUT_SELECTOR, PLATFORM_SELECTION_ITEM_SELECTOR } from '../platforms/registry'

/** 按通用分隔符拆开多级值。连写的行政区名称再按后缀切一刀，这只用于拆字。 */
export function splitCascadeValue(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  const bySeparator = trimmed.split(/\s*[/|>»→\-—、,，|]\s*/).map(item => item.trim()).filter(Boolean)
  if (bySeparator.length > 1) return bySeparator
  const bySpace = trimmed.split(/\s+/).map(item => item.trim()).filter(Boolean)
  if (bySpace.length > 1 && bySpace.length <= 4 && bySpace.every(part => part.length >= 2 && part.length <= 20)) return bySpace
  const byRegion = trimmed.match(/[^省市区县旗盟]+?(?:省|市|区|县|旗|盟|自治区|自治州|自治县)/g)
  if (byRegion && byRegion.length) {
    // 连写行政区可能末级缺后缀（江西省吉安市永丰），把被带后缀部分消费掉之后的剩余作为末级补上。
    const consumed = byRegion.join('')
    const rest = trimmed.startsWith(consumed) ? trimmed.slice(consumed.length).trim() : ''
    const parts = (rest && rest.length >= 2 ? [...byRegion, rest] : byRegion).map(item => item.trim())
    if (parts.length > 1) return parts
  }
  return [trimmed]
}

function optionText(node: HTMLElement): string {
  return plainChoiceText(node.textContent || '')
}

function realOptions(nodes: HTMLElement[]): HTMLElement[] {
  return nodes.filter(node => {
    const text = optionText(node)
    return Boolean(text) && !isPlaceholderOption(text)
  })
}

type OptionPick = { status: 'found'; node: HTMLElement; weak?: boolean } | { status: 'missing' }

function pickOption(nodes: HTMLElement[], value: string): OptionPick {
  const match = matchOption(nodes.map(optionText), value)
  if (match.index < 0 || !nodes[match.index]) return { status: 'missing' }
  // 并列最高分时按选项原顺序选择第一个，并用橙色提示。
  return { status: 'found', node: nodes[match.index], weak: match.reason === 'prefix' || match.ambiguous }
}

/**
 * 点中一级之后，只有可见选项的文字变了才点下一级。
 * 同一列表被换掉，或多出一批新选项，都算下一级。不看组件库的列名。
 */
async function stepThroughOptions(
  scope: HTMLElement,
  value: string,
  input: HTMLInputElement | null,
  trusted = false,
  allowSearch = true,
  projectWholeValue = false
): Promise<WriteAttempt> {
  const levels = splitCascadeValue(value)
  let host = scope
  let weak = false
  const nodesNow = () => realOptions(popupOptions(host.isConnected ? host : document.body))
  const full = pickOption(nodesNow(), value)
  if (full.status === 'found') {
    await activateElement(full.node, trusted)
    await wait(120)
    return { applied: true, viaProjection: Boolean(full.weak) }
  }
  if (levels.length <= 1 && !projectWholeValue) return { applied: false, reasonCode: 'no-matching-option' }

  let previousTexts: string[] = []
  const selectedTexts: string[] = []
  const levelCount = levels.length > 1 ? levels.length : 8
  for (let level = 0; level < levelCount; level += 1) {
    const poolFor = () => {
      const pool = nodesNow()
      if (!level || !previousTexts.length) return pool
      const fresh = pool.filter(node => !previousTexts.includes(optionText(node)))
      return fresh.length ? fresh : pool
    }
    const pool = poolFor()
    const target = levels.length > 1 ? levels[level] : value
    let picked = pickOption(pool, target)
    if (picked.status === 'missing' && projectWholeValue) {
      const projected = projectOptionFromValue(pool.map(optionText), value, selectedTexts)
      if (projected && pool[projected.index]) { picked = { status: 'found', node: pool[projected.index], weak: true } }
    }
    if (picked.status === 'missing' && allowSearch && input && !input.readOnly) {
      if (!trusted || !await trustedReplaceText(input, target)) setNativeText(input, target)
      await wait(320)
      const searchedPool = poolFor()
      picked = pickOption(searchedPool, target)
      if (picked.status === 'missing' && projectWholeValue) {
        const projected = projectOptionFromValue(searchedPool.map(optionText), value, selectedTexts)
        if (projected && searchedPool[projected.index]) { picked = { status: 'found', node: searchedPool[projected.index], weak: true } }
      }
    }
    if (picked.status !== 'found') {
      return { applied: false, reasonCode: 'no-matching-option', detail: `第 ${level + 1} 级找不到唯一匹配` }
    }
    if (picked.weak) weak = true
    previousTexts = nodesNow().map(optionText)
    selectedTexts.push(optionText(picked.node))
    await activateElement(picked.node, trusted)
    if (levels.length > 1 && level === levels.length - 1) {
      await wait(120)
      return { applied: true, viaProjection: weak }
    }
    const transition = await pollUntil<{ status: 'next'; host: HTMLElement } | { status: 'done' } | null>(() => {
      if (!host.isConnected || !isElementVisible(host)) return { status: 'done' }
      const current = host.isConnected ? host : document.body
      const texts = realOptions(popupOptions(current)).map(optionText)
      if (!texts.length || texts.join('\n') === previousTexts.join('\n')) return null
      return { status: 'next', host: current }
    }, 1500)
    if (transition?.status === 'done' && projectWholeValue) return { applied: true, viaProjection: weak }
    if (!transition) {
      return { applied: false, reasonCode: 'option-list-not-found', detail: '下一级未出现' }
    }
    if (transition.status === 'done') return { applied: false, reasonCode: 'option-list-not-found', detail: '下一级未出现' }
    host = transition.host
  }
  return { applied: true, viaProjection: weak }
}

/**
 * 控件识别器（ControlRecognizer，TECH_DESIGN §8.2）。
 *
 * 从「页面级互斥适配器」改为「控件级能力叠加」：按控件而非按页面生效，
 * 同页混用多套组件库时各控件独立选择识别器。原生控件识别器优先级最低作为兜底。
 */

export interface ControlContext {
  ref: FieldRef
  request?: FillRequest
}

export interface WriteAttempt {
  /** 是否完成了写入操作（成功与否由状态机回读裁定）。 */
  applied: boolean
  reasonCode?: FillReasonCode
  detail?: string
  /** 命中的选项来自模糊投影 / 前缀匹配，而非精确或同义命中，需用户复核。 */
  viaProjection?: boolean
}

export interface ControlRecognizer {
  id: string
  /** 优先级：数值大者先试。 */
  priority: number
  match(ref: FieldRef): boolean
  read(ctx: ControlContext): string
  write(ctx: ControlContext, value: string): Promise<WriteAttempt>
  /** 普通 DOM 事件被页面拒绝时，通过浏览器协议重试一次。 */
  trustedWrite?(ctx: ControlContext, value: string): Promise<WriteAttempt>
  /** 撤销（F52）。返回 false 表示无法恢复，由调用方明确列出。 */
  restore?(ctx: ControlContext, previous: string): Promise<boolean>
  settleTimeoutMs?: number
}

function editorWindow(element: HTMLElement): Window {
  const root = element.getRootNode()
  if (root instanceof Document && root.defaultView) return root.defaultView
  return window
}

/** Quill / TinyMCE / UEditor 走编辑器 API；普通 contenteditable 用选区插入，避免只改 DOM、提交仍是空的。 */
function writeRichText(element: HTMLElement, value: string): boolean {
  const host = element.closest('.ql-container') || element.closest('.ql-editor')?.parentElement
  const quill = (host as { __quill?: { setText: (text: string) => void } } | null)?.__quill
    || (element as { __quill?: { setText: (text: string) => void } }).__quill
  if (quill?.setText) {
    quill.setText(value)
    return true
  }
  const view = editorWindow(element) as Window & {
    tinymce?: { get: (id: string) => { setContent: (html: string) => void } | null }
    UE?: { getEditor?: (id: string) => { setContent: (html: string) => void } | null }
  }
  const editorId = element.id
  const tiny = editorId ? view.tinymce?.get(editorId) : null
  if (tiny?.setContent) {
    tiny.setContent(value.replace(/\n/g, '<br>'))
    return true
  }
  const ueditor = editorId ? view.UE?.getEditor?.(editorId) : null
  if (ueditor?.setContent) {
    ueditor.setContent(value)
    return true
  }
  if (!element.isContentEditable && element.getAttribute('role') !== 'textbox') return false
  element.focus()
  const doc = view.document
  const selection = view.getSelection?.()
  if (selection && doc) {
    const range = doc.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
    if (doc.execCommand?.('insertText', false, value)) {
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      return true
    }
  }
  element.textContent = value
  dispatchFieldEvents(element)
  return true
}

function clickElement(element: HTMLElement): void {
  const options: MouseEventInit = { bubbles: true, cancelable: true }
  element.dispatchEvent(new MouseEvent('pointerdown', options))
  element.dispatchEvent(new MouseEvent('mousedown', options))
  element.dispatchEvent(new MouseEvent('pointerup', options))
  element.dispatchEvent(new MouseEvent('mouseup', options))
  element.click()
}

async function activateElement(element: HTMLElement, trusted = false): Promise<void> {
  if (trusted && await trustedClickElement(element)) return
  clickElement(element)
}

function splitMulti(value: string): string[] {
  return value.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
}

// ─── 原生文本 ────────────────────────────────────────────────

const textRecognizer: ControlRecognizer = {
  id: 'native-text',
  priority: 0,
  match: ref => ['text', 'textarea'].includes(ref.kind),
  read: ctx => readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const element = ctx.ref.element
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeText(element, value)
      return { applied: true }
    }
    if (writeRichText(element, value)) return { applied: true }
    return { applied: false, reasonCode: 'unsupported-control' }
  },
  async trustedWrite(ctx, value) {
    return { applied: await trustedReplaceText(ctx.ref.element, value), reasonCode: 'trusted-input-failed' }
  },
  async restore(ctx, previous) {
    const result = await this.write(ctx, previous)
    return result.applied
  }
}

// ─── 原生 select（含多选与原生级联）─────────────────────────

const nativeSelectRecognizer: ControlRecognizer = {
  id: 'native-select',
  priority: 0,
  match: ref => ref.element instanceof HTMLSelectElement,
  read: ctx => readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const select = ctx.ref.element as HTMLSelectElement
    const options = Array.from(select.options)
    if (select.multiple) {
      const requested = splitMulti(value)
      if (!requested.length) return { applied: false, reasonCode: 'no-matching-option' }
      let matched = 0
      options.forEach((option, index) => {
        const target = requested.some(item => matchOption([option.text], item).index === 0 || matchOption([option.value], item).index === 0)
        options[index].selected = target
        if (target) matched += 1
      })
      if (!matched) return { applied: false, reasonCode: 'no-matching-option' }
      dispatchFieldEvents(select)
      return { applied: true }
    }
    const match = matchOption(options.map(option => option.text), value)
    if (match.index < 0) {
      const levels = splitCascadeValue(value)
      const hidden = selectIsHidden(select)
      const list = hidden ? listsBesideSelect(select).find(item => realOptions(popupOptions(item)).length) : undefined
      if (levels.length > 1 && list) return stepThroughOptions(list, value, null, false, true, true)
      return { applied: false, reasonCode: 'no-matching-option' }
    }
    const option = options[match.index]
    option.selected = true
    select.selectedIndex = match.index
    setNativeSelect(select, option.value)
    revealHiddenSelectOption(select, option.text)
    if (ctx.ref.kind === 'cascade') await wait(200) // 等待级联下一级刷新
    return { applied: true, viaProjection: match.reason === 'prefix' }
  },
  async restore(ctx, previous) {
    const select = ctx.ref.element as HTMLSelectElement
    if (!previous) {
      Array.from(select.options).forEach(option => { option.selected = false })
      if (!select.multiple) select.selectedIndex = 0
      dispatchFieldEvents(select)
      return true
    }
    const result = await this.write(ctx, previous)
    return result.applied
  }
}

const NATIVE_TEMPORAL = ['date', 'month', 'time', 'datetime-local', 'week']

function formatNativeTemporal(input: HTMLInputElement, value: string): string {
  if (input.type === 'time') {
    const match = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
    if (!match) return value.trim()
    const clock = `${match[1].padStart(2, '0')}:${match[2]}`
    return match[3] ? `${clock}:${match[3].padStart(2, '0')}` : clock
  }
  if (input.type === 'month' || input.type === 'week') return normalizeDateValue(value, true)
  const date = normalizeDateValue(value, false)
  if (input.type === 'datetime-local') {
    const time = value.match(/(\d{1,2}):(\d{2})/)
    return time ? `${date}T${time[1].padStart(2, '0')}:${time[2]}` : `${date}T00:00`
  }
  return date
}

const LIST_SELECTOR = 'ul,[role="listbox"],[class*="dropdown"],[class*="options"]'

function pushList(lists: HTMLElement[], node: HTMLElement | null | undefined): void {
  if (!node || lists.includes(node)) return
  lists.push(node)
}

/** 藏起来的 select 旁边的可见列表：aria-controls、同级、父级的兄弟。 */
function listsBesideSelect(select: HTMLSelectElement): HTMLElement[] {
  const lists: HTMLElement[] = []
  const owned = select.getAttribute('aria-controls')
  if (owned) pushList(lists, select.ownerDocument.getElementById(owned))
  const host = select.parentElement
  if (host?.matches(LIST_SELECTOR)) pushList(lists, host)
  pushList(lists, host?.querySelector<HTMLElement>(LIST_SELECTOR))
  const consider = (sibling: Element | null) => {
    if (!(sibling instanceof HTMLElement) || sibling === select || sibling === host) return
    if (sibling.matches(LIST_SELECTOR)) pushList(lists, sibling)
    pushList(lists, sibling.querySelector<HTMLElement>(LIST_SELECTOR))
  }
  if (host) Array.from(host.children).forEach(consider)
  if (host?.parentElement) Array.from(host.parentElement.children).forEach(consider)
  return lists
}

function clickMatchingItem(list: HTMLElement, label: string): boolean {
  const items = Array.from(list.querySelectorAll<HTMLElement>('li,[role="option"]'))
  const match = matchOption(items.map(item => item.textContent?.trim() || ''), label)
  if (match.index < 0 || !items[match.index]) return false
  clickElement(items[match.index])
  return true
}

function selectIsHidden(select: HTMLSelectElement): boolean {
  const style = getComputedStyle(select)
  return style.display === 'none' || style.visibility === 'hidden' || !select.getClientRects().length
}

/** 原生 select 被藏起来时，旁边的自定义列表不会跟着 value 变，要点可见项。 */
function revealHiddenSelectOption(select: HTMLSelectElement, label: string): void {
  if (!selectIsHidden(select)) return
  for (const list of listsBesideSelect(select)) {
    if (clickMatchingItem(list, label)) return
  }
}

// ─── 原生日期 / 时间 ─────────────────────────────────────────

const nativeDateRecognizer: ControlRecognizer = {
  id: 'native-date',
  priority: 5,
  match: ref => ref.element instanceof HTMLInputElement && NATIVE_TEMPORAL.includes(ref.element.type),
  read: ctx => (ctx.ref.element as HTMLInputElement).value,
  async write(ctx, value) {
    const input = ctx.ref.element as HTMLInputElement
    setNativeText(input, formatNativeTemporal(input, value))
    return { applied: true }
  },
  async restore(ctx, previous) {
    setNativeText(ctx.ref.element as HTMLInputElement, previous)
    return true
  }
}

// ─── radio / checkbox ────────────────────────────────────────

const RADIO_HIT = '.el-radio__inner,.el-radio-button__inner,.ant-radio-inner,.ant-radio-button,.arco-radio-mask,.van-radio__icon,.t-radio__input,.semi-radio-inner,.n-radio__dot,.el-radio__label'

/** 只包住当前这一项的那一层。整题的 label 里有多个选项时不能点到它，否则总会点中第一项。 */
function exclusiveOptionRoot(radio: HTMLElement): HTMLElement {
  let node = radio.parentElement
  let best: HTMLElement = radio
  while (node && node !== document.body && node !== document.documentElement) {
    const inputs = node.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')
    const foreign = Array.from(inputs).some(item => item !== radio && !radio.contains(item) && !item.contains(radio))
    if (foreign) break
    best = node
    node = node.parentElement
  }
  return best
}

/** 点可见的选项根，让组件自己的点击处理函数跑。点不中再改原生 checked。 */
function activateRadio(radio: HTMLInputElement): boolean {
  const wrapper = exclusiveOptionRoot(radio)
  const hit = wrapper.querySelector<HTMLElement>(RADIO_HIT)
  const target = hit && hit !== radio ? hit : wrapper !== radio ? wrapper : null
  if (target) clickElement(target)
  else radio.click()
  if (!radio.checked) setNativeChecked(radio, true)
  return radio.checked
}

const choiceRecognizer: ControlRecognizer = {
  id: 'native-choice',
  priority: 0,
  match: ref => ref.kind === 'radio' || ref.kind === 'checkbox',
  read: ctx => readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const ref = ctx.ref
    if (ref.kind === 'radio') {
      const radios = ref.radios || []
      const choices = ref.choices || []
      const nodes: HTMLElement[] = radios.length ? radios : choices
      const labels = nodes.map(node => optionLabel(node))
      const match = matchOption(labels, value)
      if (match.index < 0 || !nodes[match.index]) {
        return { applied: false, reasonCode: 'no-matching-option' }
      }
      const target = nodes[match.index]
      if (target instanceof HTMLInputElement) return { applied: activateRadio(target), viaProjection: Boolean(match.ambiguous || match.reason === 'prefix') }
      clickElement(target)
      target.setAttribute(target.hasAttribute('aria-pressed') ? 'aria-pressed' : 'aria-checked', 'true')
      for (const other of nodes) {
        if (other !== target) other.setAttribute(other.hasAttribute('aria-pressed') ? 'aria-pressed' : 'aria-checked', 'false')
      }
      return { applied: true, viaProjection: Boolean(match.ambiguous || match.reason === 'prefix') }
    }
    const checkboxes: HTMLElement[] = [...(ref.checkboxes || []), ...(ref.choices || [])]
    if (!checkboxes.length) checkboxes.push(ref.element)
    const checked = (node: HTMLElement) => node instanceof HTMLInputElement
      ? node.checked
      : node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-pressed') === 'true'
    const toggle = (node: HTMLElement, target: boolean) => {
      if (checked(node) === target) return true
      if (node instanceof HTMLInputElement) {
        node.click()
        if (node.checked !== target) setNativeChecked(node, target)
      } else {
        clickElement(node)
      }
      return checked(node) === target
    }
    if (checkboxes.length === 1) {
      const target = booleanValue(value)
      if (target === null) return { applied: false, reasonCode: 'no-matching-option' }
      const checkbox = checkboxes[0]
      const applied = toggle(checkbox, target)
      if (checkbox instanceof HTMLInputElement) dispatchFieldEvents(checkbox)
      return { applied }
    }
    const requested = splitMulti(value)
    if (!requested.length) return { applied: false, reasonCode: 'no-matching-option' }
    for (const checkbox of checkboxes) {
      const label = optionLabel(checkbox) || (checkbox instanceof HTMLInputElement ? checkbox.value : '')
      const target = requested.some(item => matchOption([label], item).index === 0)
      if (!toggle(checkbox, target)) return { applied: false, reasonCode: 'timeout', detail: `选项「${label || '未命名'}」未响应点击` }
      if (checkbox instanceof HTMLInputElement) dispatchFieldEvents(checkbox)
    }
    return { applied: requested.every(item => checkboxes.some(node => checked(node) && matchOption([optionLabel(node) || (node instanceof HTMLInputElement ? node.value : '')], item).index === 0)) }
  }
}

// ─── 组件库日期 picker（ant-picker / el-date-editor，F11）────

function innerInput(element: HTMLElement): HTMLInputElement | null {
  if (element instanceof HTMLInputElement) return element
  return element.querySelector<HTMLInputElement>('input')
}

const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const PREV_YEAR = '.ant-picker-header-super-prev-btn,.el-picker-panel__icon-btn.d-arrow-left,.el-date-picker__prev-btn.el-icon-d-arrow-left,[aria-label*="上一年"],[aria-label*="previous year"],[data-action="prev-year"]'
const NEXT_YEAR = '.ant-picker-header-super-next-btn,.el-picker-panel__icon-btn.d-arrow-right,.el-date-picker__next-btn.el-icon-d-arrow-right,[aria-label*="下一年"],[aria-label*="next year"],[data-action="next-year"]'
const PREV_MONTH = '.ant-picker-header-prev-btn,.el-picker-panel__icon-btn.arrow-left,.el-date-picker__prev-btn.el-icon-arrow-left,[aria-label*="上个月"],[aria-label*="previous month"],[data-action="prev-month"]'
const NEXT_MONTH = '.ant-picker-header-next-btn,.el-picker-panel__icon-btn.arrow-right,.el-date-picker__next-btn.el-icon-arrow-right,[aria-label*="下个月"],[aria-label*="next month"],[data-action="next-month"]'

interface DateParts {
  year: number
  month: number
  day: number
  hour?: number
  minute?: number
}

function parseDateParts(value: string): DateParts | null {
  const time = value.match(/(\d{1,2}):(\d{2})/)
  const normalized = normalizeDateValue(value, false)
  const date = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!date) {
    if (!time) return null
    return { year: 0, month: 0, day: 0, hour: Number(time[1]), minute: Number(time[2]) }
  }
  return {
    year: Number(date[1]),
    month: Number(date[2]),
    day: Number(date[3]),
    hour: time ? Number(time[1]) : undefined,
    minute: time ? Number(time[2]) : undefined
  }
}

function formatDateForInput(input: HTMLInputElement, value: string): string {
  const hints = [input.getAttribute('format'), input.placeholder, input.value].filter(Boolean).join(' ')
  const parts = parseDateParts(value)
  if (!parts?.year) {
    if (parts?.hour != null) return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute ?? 0).padStart(2, '0')}`
    return value.trim()
  }
  const monthOnly = /yyyy[-/.年]?mm(?![-/.月]?dd)/i.test(hints) && !/dd|日/i.test(hints)
  const year = String(parts.year)
  const month = String(parts.month).padStart(2, '0')
  const day = String(parts.day || 1).padStart(2, '0')
  if (/年/.test(hints) && /月/.test(hints)) {
    return monthOnly || !/日|dd/i.test(hints) ? `${year}年${month}月` : `${year}年${month}月${day}日`
  }
  const separator = hints.match(/yyyy([-/.])mm/i)?.[1] || (hints.includes('.') ? '.' : hints.includes('/') ? '/' : '-')
  return monthOnly ? `${year}${separator}${month}` : `${year}${separator}${month}${separator}${day}`
}

function parseMonthText(text: string): number {
  const named = MONTH_NAMES.findIndex(name => text.includes(name))
  if (named >= 0) return named + 1
  const numeric = text.match(/(\d{1,2})\s*月/)
  return numeric ? Number(numeric[1]) : 0
}

function shownYearMonth(popup: HTMLElement): { year: number; month: number } | null {
  const yearNode = popup.querySelector('.ant-picker-year-btn')
  if (yearNode) {
    const year = Number(yearNode.textContent?.match(/(?:19|20)\d{2}/)?.[0])
    if (!year) return null
    return { year, month: parseMonthText(popup.querySelector('.ant-picker-month-btn')?.textContent || '') }
  }
  const labels = Array.from(popup.querySelectorAll('.el-date-picker__header-label'))
  const year = Number(labels.map(node => node.textContent || '').join(' ').match(/(?:19|20)\d{2}/)?.[0])
  if (!year) {
    const header = popup.querySelector<HTMLElement>('.phoenix-picker-header,.ud-picker-header,[class*="picker-header"],[class*="calendar-header"]')
    const text = (header?.textContent || '').replace(/\s+/g, ' ')
    const genericYear = Number(text.match(/(?:19|20)\d{2}/)?.[0])
    if (!genericYear) return null
    return { year: genericYear, month: parseMonthText(text) }
  }
  const monthLabel = labels.find(node => /月/.test(node.textContent || ''))
  return { year, month: parseMonthText(monthLabel?.textContent || '') }
}

async function alignPicker(popup: HTMLElement, year: number, month: number): Promise<void> {
  if (!year) return
  for (let step = 0; step < 40; step += 1) {
    const shown = shownYearMonth(popup)
    if (!shown) return
    if (shown.year === year && (shown.month === month || shown.month === 0)) return
    const button = shown.year > year
      ? popup.querySelector<HTMLElement>(PREV_YEAR)
      : shown.year < year
        ? popup.querySelector<HTMLElement>(NEXT_YEAR)
        : shown.month > month
          ? popup.querySelector<HTMLElement>(PREV_MONTH)
          : popup.querySelector<HTMLElement>(NEXT_MONTH)
    if (!button) return
    const before = `${shown.year}-${shown.month}`
    clickElement(button)
    await wait(40)
    const after = shownYearMonth(popup)
    if (`${after?.year}-${after?.month}` === before) return
  }
}

function clickCell(cell: HTMLElement): void {
  const inner = cell.querySelector<HTMLElement>('.ant-picker-cell-inner,.el-date-table-cell,.el-date-table-cell__text,.phoenix-picker-cell-inner,.ud-picker-cell-inner,span') || cell
  clickElement(inner)
}

function findDayCell(popup: HTMLElement, day: number): HTMLElement | null {
  const cells = Array.from(popup.querySelectorAll<HTMLElement>('.ant-picker-cell-in-view,.el-date-table td.available,.el-date-table td,.phoenix-picker-cell,.ud-picker-cell,[data-date]'))
  return cells.find(cell => {
    const className = `${cell.className} ${cell.parentElement?.className || ''}`
    if (/disabled|prev-month|next-month/.test(className)) return false
    const text = (cell.querySelector('.ant-picker-cell-inner,.phoenix-picker-cell-inner,.ud-picker-cell-inner,span') || cell).textContent?.trim()
    return text === String(day)
  }) || null
}

function findMonthCell(popup: HTMLElement, year: number, month: number): HTMLElement | null {
  const title = `${year}-${String(month).padStart(2, '0')}`
  const titled = popup.querySelector<HTMLElement>(`[title="${title}"]`)
  if (titled) return titled
  const labels = [String(month), `${month}月`, MONTH_NAMES[month - 1]].filter(Boolean)
  const cells = Array.from(popup.querySelectorAll<HTMLElement>('.ant-picker-cell,.el-month-table td,.el-month-table .cell,.phoenix-picker-cell,.ud-picker-cell,[data-month]'))
  return cells.find(cell => {
    const text = (cell.textContent || '').replace(/\s+/g, '')
    return text.length <= 4 && labels.some(label => text === label.replace(/\s+/g, ''))
  }) || null
}

function clickTime(popup: HTMLElement, hour: number, minute: number): boolean {
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const direct = Array.from(popup.querySelectorAll<HTMLElement>('.time-select-item,.el-select-dropdown__item,li')).find(node => (node.textContent || '').includes(clock))
  if (direct && !popup.querySelector('.ant-picker-time-panel-column,.el-time-spinner__wrapper')) {
    clickElement(direct)
    return true
  }
  const columns = Array.from(popup.querySelectorAll<HTMLElement>('.ant-picker-time-panel-column,.el-time-spinner__wrapper,.el-time-spinner__list'))
  if (columns.length < 2) return false
  const pick = (column: HTMLElement, text: string) => {
    const cell = Array.from(column.querySelectorAll<HTMLElement>('li,.ant-picker-time-panel-cell')).find(node => (node.textContent || '').trim() === text)
    if (cell) clickElement(cell)
  }
  pick(columns[0], String(hour).padStart(2, '0'))
  pick(columns[1], String(minute).padStart(2, '0'))
  return true
}

function clickConfirm(popup: HTMLElement): void {
  const confirm = Array.from(popup.querySelectorAll<HTMLElement>('button,.el-time-panel__btn,.ant-picker-ok'))
    .find(button => /^(确定|确认|ok)$/i.test((button.textContent || '').trim()))
  if (confirm) clickElement(confirm)
}

function clickOngoing(scope: ParentNode): boolean {
  const node = Array.from(scope.querySelectorAll<HTMLElement>('button,a,span,label,li,div'))
    .find(item => /^(至今|现在|目前|在读)$/.test((item.textContent || '').replace(/\s+/g, '')))
  if (!node) return false
  clickElement(node)
  return true
}

function rangeInputs(element: HTMLElement): HTMLInputElement[] {
  const host = element.closest(['.ant-picker-range,.el-range-editor,.el-date-editor--daterange,.el-date-editor--monthrange', PLATFORM_RANGE_SELECTOR].filter(Boolean).join(','))
  if (!host) return []
  return Array.from(host.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])'))
}

/** 带连字符的学校名、专业名不要拆成级联。行政区或明确的多级分隔符才逐级点。 */
function shouldStepCascade(value: string): boolean {
  const levels = splitCascadeValue(value)
  if (levels.length <= 1) return false
  return /省|市|区|县|自治区/.test(value) || /[/|>»→]/.test(value)
}

/** 打开面板后点中对应的日、月或时刻。点不到时返回 false，交给输入框兜底。 */
async function chooseInPicker(popup: HTMLElement, value: string, input: HTMLInputElement): Promise<boolean> {
  if (isOngoingDate(value)) return clickOngoing(popup)
  const parts = parseDateParts(value)
  if (!parts) return false
  const hints = [input.getAttribute('format'), input.placeholder].filter(Boolean).join(' ')
  const monthOnly = /yyyy[-/.年]?mm(?![-/.月]?dd)/i.test(hints) && !/dd|日/i.test(hints)
  if (parts.year) {
    await alignPicker(popup, parts.year, parts.month)
    const monthTitle = `${parts.year}-${String(parts.month).padStart(2, '0')}`
    const dayTitle = `${monthTitle}-${String(parts.day).padStart(2, '0')}`
    const dayExact = monthOnly ? null : popup.querySelector<HTMLElement>(`[title="${dayTitle}"]`)
    const monthExact = popup.querySelector<HTMLElement>(`[title="${monthTitle}"]`)
    const dayCell = dayExact || (monthOnly ? null : findDayCell(popup, parts.day))
    const monthCell = monthExact || findMonthCell(popup, parts.year, parts.month)
    const target = dayCell || monthCell
    if (!target) return false
    clickCell(target)
  }
  if (parts.hour != null) clickTime(popup, parts.hour, parts.minute ?? 0)
  clickConfirm(popup)
  return parts.year > 0 || parts.hour != null
}

const datePickerRecognizer: ControlRecognizer = {
  id: 'library-date-picker',
  priority: 10,
  settleTimeoutMs: 2500,
  match: ref => ref.kind === 'date' && !(ref.element instanceof HTMLInputElement && NATIVE_TEMPORAL.includes(ref.element.type)),
  read: ctx => innerInput(ctx.ref.element)?.value || readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const input = innerInput(ctx.ref.element)
    if (!input) return { applied: false, reasonCode: 'unsupported-control' }
    const library = Boolean(input.closest(['.ant-picker,.el-date-editor,.arco-picker,.ivu-date-picker,.n-date-picker,[class*="date-picker"],[class*="datepicker"],[class*="time-picker"]', PLATFORM_DATE_SELECTOR].filter(Boolean).join(',')))
    const watch = watchForPopup(ctx.ref.element)
    try {
      const before = input.value.trim()
      const pair = rangeInputs(input)
      const range = pair.length >= 2 ? splitOngoingRange(value) : null
      if (range?.start && range.end && pair.length >= 2) {
        setNativeText(pair[0], formatDateForInput(pair[0], range.start))
        if (isOngoingDate(range.end)) {
          clickElement(pair[1])
          const popup = await watch.locate()
          if (!popup || !clickOngoing(popup)) setNativeText(pair[1], range.end)
        } else {
          setNativeText(pair[1], formatDateForInput(pair[1], range.end))
        }
        pair[1].blur()
        return { applied: true }
      }
      input.focus()
      clickElement(input.closest(['.ant-picker,.el-date-editor,.arco-picker', PLATFORM_DATE_SELECTOR].filter(Boolean).join(',')) || input)
      let picked = false
      if (library) {
        const popup = await watch.locate()
        if (popup) {
          picked = await chooseInPicker(popup, value, input)
          if (picked) {
            const committed = await pollUntil(() => {
              const current = input.value.trim()
              return current && current !== before ? current : null
            }, 400)
            if (committed) {
              input.blur()
              return { applied: true }
            }
          }
        }
      }
      const formatted = formatDateForInput(input, value)
      setNativeText(input, formatted)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
      input.blur()
      return { applied: true }
    } finally {
      watch.dispose()
    }
  },
  async restore(ctx, previous) {
    const input = innerInput(ctx.ref.element)
    if (!input) return false
    if (!previous) {
      const clear = ctx.ref.element.querySelector<HTMLElement>('.ant-picker-clear,.el-input__clear,[class*="clear"]')
      if (clear) { clickElement(clear); return true }
    }
    setNativeText(input, previous)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    return true
  }
}

// ─── 自定义下拉（combobox，含虚拟滚动 F18）──────────────────

const MAX_FILTER_ATTEMPTS = 4
const MAX_SCROLL_DURATION_MS = 6_000

function optionSignature(popup: HTMLElement): string {
  return realOptions(popupOptions(popup)).map(optionText).join('\n')
}

/** 等待远程搜索或虚拟列表完成一轮更新，并连续两次保持稳定。 */
async function waitForOptionsStable(popup: HTMLElement, previous = '', timeoutMs = 1_600): Promise<string> {
  let latest = optionSignature(popup)
  let stableRounds = 0
  const settled = await pollUntil<string | null>(() => {
    const current = optionSignature(popup)
    if (current !== latest) {
      latest = current
      stableRounds = 0
      return null
    }
    stableRounds += 1
    if (stableRounds >= 2 && (current !== previous || stableRounds >= 3)) return current
    return null
  }, timeoutMs)
  return settled ?? optionSignature(popup)
}

async function loadMoreOptions(popup: HTMLElement, trusted = false): Promise<'changed' | 'end' | 'stalled'> {
  const marked = popup.querySelector<HTMLElement>('.rc-virtual-list-holder,.el-scrollbar__wrap,.arco-virtual-list,.semi-select-option-list,.phoenix-virtual-list,.ud-virtual-list,[class*="virtual-list-holder"]')
  const scroller = marked || Array.from(popup.querySelectorAll<HTMLElement>('*')).find(node => node.scrollHeight > node.clientHeight + 24)
  if (!scroller) return 'end'
  const before = optionSignature(popup)
  const previousTop = scroller.scrollTop
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const delta = Math.max(scroller.clientHeight, 120)
  const usedTrusted = trusted && await trustedScrollElement(scroller, delta)
  if (!usedTrusted) {
    scroller.scrollTop = Math.min(maxTop, previousTop + delta)
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  }
  const after = await waitForOptionsStable(popup, before)
  if (after !== before) return 'changed'
  if (scroller.scrollTop >= maxTop - 1 || scroller.scrollTop === previousTop) return 'end'
  return 'stalled'
}

/**
 * ARIA 键盘路径：只有当 aria-activedescendant 的文字唯一命中目标时才发 Enter。
 * ArrowDown 只改变高亮，不会在未确定目标时提交选择。
 */
async function selectByActiveDescendant(trigger: HTMLElement, popup: HTMLElement, value: string): Promise<boolean> {
  const keyboardTarget = trigger instanceof HTMLInputElement
    ? trigger
    : trigger.querySelector<HTMLElement>('input,[role="combobox"],[tabindex]:not([tabindex="-1"])') || trigger
  keyboardTarget.focus({ preventScroll: true })
  const activeOption = () => {
    const owner = [keyboardTarget, trigger].find(node => node.hasAttribute('aria-activedescendant'))
    const id = owner?.getAttribute('aria-activedescendant')
    const node = id ? keyboardTarget.ownerDocument.getElementById(id) : null
    return node instanceof HTMLElement && (popup === node || popup.contains(node)) ? node : null
  }
  const commitIfMatched = () => {
    const active = activeOption()
    if (!active || matchOption([optionText(active)], value).index !== 0) return false
    keyboardTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    keyboardTarget.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    return true
  }
  if (commitIfMatched()) return true
  const limit = Math.min(40, Math.max(1, realOptions(popupOptions(popup)).length + 1))
  for (let index = 0; index < limit; index += 1) {
    keyboardTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }))
    keyboardTarget.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }))
    await wait(20)
    if (commitIfMatched()) return true
  }
  return false
}

/** 对一个自定义下拉值完成“展开—搜索/滚动—点击”。多选会为每个值重复调用。 */
async function selectCustomValue(trigger: HTMLElement, value: string, trusted = false, capabilities?: ControlCapabilities, allowProjection = false): Promise<WriteAttempt> {
  trusted = trusted && capabilities?.canTrustedInput !== false
  const alreadyOpen = visiblePopupFor(trigger)
  const watch = watchForPopup(trigger)
  try {
    const clickable = trigger.querySelector<HTMLElement>(['.ant-select-selector,.el-select__wrapper,.el-input__wrapper,.el-input,.arco-select-view,.n-base-selection,.ivu-select-selection,.semi-select-selection,.t-select__wrap,.t-input__wrap', PLATFORM_SELECTION_ITEM_SELECTOR].filter(Boolean).join(',')) || trigger
    if (!alreadyOpen) await activateElement(clickable, trusted)
    const input = trigger instanceof HTMLInputElement ? trigger : trigger.querySelector<HTMLInputElement>(['input:not([type="hidden"])', PLATFORM_SEARCH_INPUT_SELECTOR].filter(Boolean).join(','))
    const popup = alreadyOpen || await watch.locate()
    if (!popup) return { applied: false, reasonCode: 'option-list-not-found' }

    // 多级值（省市区或带分隔符）始终逐级点击。开启投影时每层用 projectOptionFromValue 做模糊匹配，
    // 不再因为 allowProjection 而被旁路成扁平投影，避免省市区选错。
    if (shouldStepCascade(value)) {
      if (!realOptions(popupOptions(popup)).length) return { applied: false, reasonCode: 'option-list-not-found', detail: '选项尚未出现' }
      return stepThroughOptions(popup, value, input, trusted, capabilities?.canSearch !== false, allowProjection)
    }

    const tryVisible = async (): Promise<WriteAttempt | null> => {
      const options = popupOptions(popup)
      const texts = options.map(option => optionText(option))
      const match = matchOption(texts, value)
      if (match.index >= 0) {
        const option = options[match.index]
        option.scrollIntoView?.({ block: 'nearest' })
        await activateElement(option, trusted)
        return { applied: true, viaProjection: match.reason === 'prefix' || Boolean(match.ambiguous) }
      }
      if (allowProjection) {
        const projected = projectOptionFromValue(texts, value)
        if (projected && options[projected.index]) {
          const option = options[projected.index]
          option.scrollIntoView?.({ block: 'nearest' })
          await activateElement(option, trusted)
          return { applied: true, viaProjection: projected.reason === 'projection' || projected.ambiguous }
        }
      }
      return null
    }

    let searchDirtied = false
    const clearSearch = async (): Promise<void> => {
      // 自由输入型下拉没选中选项时会把搜索词当成值留下来，失败前必须清空，避免“把原始值打上去”。
      if (!searchDirtied || !input || input.readOnly) return
      if (!trusted || !await trustedReplaceText(input, '')) setNativeText(input, '')
    }

    let visible = await tryVisible()
    if (visible) { if (visible.applied) await wait(120); return visible }

    if (capabilities?.canSearch !== false && input && !input.readOnly) {
      const filters = [...new Set(Array.from({ length: MAX_FILTER_ATTEMPTS }, (_, index) =>
        index === 0 ? value : value.slice(0, Math.max(1, value.length - index))))]
      for (const filter of filters) {
        const before = optionSignature(popup)
        if (!trusted || !await trustedReplaceText(input, filter)) setNativeText(input, filter)
        searchDirtied = true
        await waitForOptionsStable(popup, before)
        visible = await tryVisible()
        if (visible) { if (visible.applied) await wait(120); return visible }
      }
    }

    if (capabilities?.canUseKeyboard !== false && await selectByActiveDescendant(trigger, popup, value)) {
      await wait(120)
      return { applied: true }
    }

    if (capabilities?.canScroll !== false) {
      const deadline = Date.now() + MAX_SCROLL_DURATION_MS
      let stalledRounds = 0
      while (Date.now() < deadline) {
        const outcome = await loadMoreOptions(popup, trusted)
        visible = await tryVisible()
        if (visible) { if (visible.applied) await wait(120); return visible }
        if (outcome === 'end') break
        stalledRounds = outcome === 'stalled' ? stalledRounds + 1 : 0
        if (stalledRounds >= 2) break
      }
    }
    await clearSearch()
    return { applied: false, reasonCode: 'no-matching-option' }
  } finally {
    watch.dispose()
  }
}

async function writeCustomSelection(ctx: ControlContext, value: string, trusted = false): Promise<WriteAttempt> {
  const trigger = ctx.ref.element
  const requested = ctx.ref.kind === 'multiselect' ? splitMulti(value) : [value.trim()]
  if (!requested.length || requested.some(item => !item)) return { applied: false, reasonCode: 'no-matching-option' }
  let viaProjection = false
  for (const item of requested) {
    const result = await selectCustomValue(trigger, item, trusted, ctx.ref.control?.capabilities, ctx.request?.valueMode === 'match-options')
    if (!result.applied) return result
    if (result.viaProjection) viaProjection = true
    // 组件可能在每次选择后关闭浮层；下一项重新从 visiblePopupFor 开始判断。
    if (requested.length > 1) await wait(100)
  }
  return { applied: true, viaProjection }
}

const comboboxRecognizer: ControlRecognizer = {
  id: 'custom-combobox',
  priority: 8,
  settleTimeoutMs: 2500,
  match: ref => ref.kind === 'combobox' || ref.kind === 'multiselect' && !(ref.element instanceof HTMLSelectElement),
  read: ctx => readCurrentValue(ctx.ref),
  write: (ctx, value) => writeCustomSelection(ctx, value),
  trustedWrite: (ctx, value) => writeCustomSelection(ctx, value, true),
  async restore(ctx, previous) {
    const trigger = ctx.ref.element
    const host = trigger.closest<HTMLElement>(['.ant-select,.el-select,.arco-select', PLATFORM_CONTROL_HOST_SELECTOR].filter(Boolean).join(',')) || trigger
    if (!previous) {
      const clear = host.querySelector<HTMLElement>('.ant-select-clear,.el-select__clear,.el-input__clear,[class*="clear"]')
      if (clear) { clickElement(clear); return true }
      return false
    }
    const result = await this.write(ctx, previous)
    return result.applied
  }
}

// ─── 自定义级联（与普通下拉共用逐级点击）────────────────────

async function writeCustomCascade(ctx: ControlContext, value: string, trusted = false): Promise<WriteAttempt> {
  trusted = trusted && ctx.ref.control?.capabilities.canTrustedInput !== false
  const trigger = ctx.ref.element
  const alreadyOpen = visiblePopupFor(trigger)
  const watch = watchForPopup(trigger)
  const rollback = async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    const host = trigger.closest<HTMLElement>('.ant-cascader,.el-cascader') || trigger
    const clear = host.querySelector<HTMLElement>('.ant-select-clear,.el-input__clear,[class*="clear"]')
    if (clear) clickElement(clear)
    await wait(100)
  }
  try {
    if (!alreadyOpen) await activateElement(trigger, trusted)
    const popup = alreadyOpen || await watch.locate()
    if (!popup) return { applied: false, reasonCode: 'option-list-not-found' }
    const input = trigger instanceof HTMLInputElement ? trigger : trigger.querySelector<HTMLInputElement>('input:not([type="hidden"])')
    if (!realOptions(popupOptions(popup)).length) return { applied: false, reasonCode: 'option-list-not-found', detail: '选项尚未出现' }
    const stepped = await stepThroughOptions(popup, value, input, trusted, ctx.ref.control?.capabilities.canSearch !== false, true)
    if (!stepped.applied) await rollback()
    return stepped
  } finally {
    watch.dispose()
  }
}

const cascaderRecognizer: ControlRecognizer = {
  id: 'custom-cascader',
  priority: 9,
  settleTimeoutMs: 3000,
  match: ref => ref.kind === 'cascade' && !(ref.element instanceof HTMLSelectElement),
  read: ctx => readCurrentValue(ctx.ref),
  write: (ctx, value) => writeCustomCascade(ctx, value),
  trustedWrite: (ctx, value) => writeCustomCascade(ctx, value, true),
  async restore(ctx, previous) {
    if (!previous) {
      const host = ctx.ref.element.closest<HTMLElement>('.ant-cascader,.el-cascader') || ctx.ref.element
      const clear = host.querySelector<HTMLElement>('.ant-select-clear,.el-input__clear,[class*="clear"]')
      if (clear) { clickElement(clear); return true }
      return false
    }
    const result = await this.write(ctx, previous)
    return result.applied
  }
}

// ─── 注册表 ──────────────────────────────────────────────────

const RECOGNIZERS: ControlRecognizer[] = [
  datePickerRecognizer,
  cascaderRecognizer,
  comboboxRecognizer,
  nativeDateRecognizer,
  nativeSelectRecognizer,
  choiceRecognizer,
  textRecognizer
]

/** 按控件解析识别器：priority 大者优先，原生识别器兜底。 */
export function resolveRecognizer(ref: FieldRef): ControlRecognizer | null {
  const capabilities = ref.control?.capabilities
  const available = (recognizer: ControlRecognizer): boolean => {
    if (!capabilities) return true
    if (recognizer.id === 'native-text') return capabilities.canSetNativeValue || capabilities.canType
    if (recognizer.id === 'native-select') return capabilities.canSetNativeValue || capabilities.canClick
    if (recognizer.id === 'native-choice') return capabilities.canClick
    if (recognizer.id === 'native-date') return capabilities.canSetNativeValue || capabilities.canType
    return capabilities.canClick
  }
  const matched = RECOGNIZERS.filter(recognizer => recognizer.match(ref) && available(recognizer))
  if (!matched.length) return null
  return matched.sort((a, b) => b.priority - a.priority)[0]
}
