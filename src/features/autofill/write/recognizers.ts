import type { FillReasonCode } from '../../../domain/types'
import type { FieldRef } from '../scan/collector'
import { readCurrentValue } from '../scan/collector'
import { isPlaceholderOption, matchOption, plainChoiceText } from '../../ontology/optionMatch'
import { booleanValue } from '../../ontology/synonyms'
import { isOngoingDate, normalizeDateValue, splitOngoingRange } from '../../ontology/validators'
import { optionLabel } from '../scan/labelResolver'
import { dispatchFieldEvents, pollUntil, setNativeChecked, setNativeSelect, setNativeText, wait } from './domUtils'
import { popupOptions, watchForPopup } from './popupLocator'

/** 按通用分隔符拆开多级值。连写的行政区名称再按后缀切一刀，这只用于拆字。 */
export function splitCascadeValue(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  const bySeparator = trimmed.split(/\s*[/|>»→\-—、,，|]\s*/).map(item => item.trim()).filter(Boolean)
  if (bySeparator.length > 1) return bySeparator
  const bySpace = trimmed.split(/\s+/).map(item => item.trim()).filter(Boolean)
  if (bySpace.length > 1 && bySpace.length <= 4 && bySpace.every(part => part.length >= 2 && part.length <= 20)) return bySpace
  const byRegion = trimmed.match(/[^省市区县旗盟]+?(?:省|市|区|县|旗|盟|自治区|自治州|自治县)/g)
  if (byRegion && byRegion.length > 1) return byRegion.map(item => item.trim())
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

type OptionPick = { status: 'found'; node: HTMLElement } | { status: 'missing' } | { status: 'ambiguous' }

function pickOption(nodes: HTMLElement[], value: string): OptionPick {
  const match = matchOption(nodes.map(optionText), value)
  if (match.ambiguous) return { status: 'ambiguous' }
  if (match.index < 0 || !nodes[match.index]) return { status: 'missing' }
  return { status: 'found', node: nodes[match.index] }
}

/**
 * 点中一级之后，只有可见选项的文字变了才点下一级。
 * 同一列表被换掉，或多出一批新选项，都算下一级。不看组件库的列名。
 */
async function stepThroughOptions(scope: HTMLElement, value: string, input: HTMLInputElement | null): Promise<WriteAttempt> {
  const levels = splitCascadeValue(value)
  let host = scope
  const nodesNow = () => realOptions(popupOptions(host.isConnected ? host : document.body))
  const full = pickOption(nodesNow(), value)
  if (full.status === 'ambiguous') return { applied: false, reasonCode: 'no-matching-option', detail: '选项存在多个匹配' }
  if (full.status === 'found') {
    clickElement(full.node)
    await wait(120)
    return { applied: true }
  }
  if (levels.length <= 1) return { applied: false, reasonCode: 'no-matching-option' }

  let previousTexts: string[] = []
  for (let level = 0; level < levels.length; level += 1) {
    const poolFor = () => {
      const pool = nodesNow()
      if (!level || !previousTexts.length) return pool
      const fresh = pool.filter(node => !previousTexts.includes(optionText(node)))
      return fresh.length ? fresh : pool
    }
    let picked = pickOption(poolFor(), levels[level])
    if (picked.status === 'missing' && input && !input.readOnly) {
      setNativeText(input, levels[level])
      await wait(320)
      picked = pickOption(poolFor(), levels[level])
    }
    if (picked.status === 'ambiguous') return { applied: false, reasonCode: 'no-matching-option', detail: '选项存在多个匹配' }
    if (picked.status !== 'found') {
      return { applied: false, reasonCode: 'no-matching-option', detail: `第 ${level + 1} 级找不到「${levels[level]}」` }
    }
    previousTexts = nodesNow().map(optionText)
    clickElement(picked.node)
    if (level === levels.length - 1) {
      await wait(120)
      return { applied: true }
    }
    const nextHost = await pollUntil(() => {
      const current = host.isConnected ? host : document.body
      const texts = realOptions(popupOptions(current)).map(optionText)
      if (!texts.length || texts.join('\n') === previousTexts.join('\n')) return null
      return current
    }, 1500)
    if (!nextHost) return { applied: false, reasonCode: 'option-list-not-found', detail: '下一级未出现' }
    host = nextHost
  }
  return { applied: true }
}

/**
 * 控件识别器（ControlRecognizer，TECH_DESIGN §8.2）。
 *
 * 从「页面级互斥适配器」改为「控件级能力叠加」：按控件而非按页面生效，
 * 同页混用多套组件库时各控件独立选择识别器。原生控件识别器优先级最低作为兜底。
 */

export interface ControlContext {
  ref: FieldRef
}

export interface WriteAttempt {
  /** 是否完成了写入操作（成功与否由状态机回读裁定）。 */
  applied: boolean
  reasonCode?: FillReasonCode
  detail?: string
}

export interface ControlRecognizer {
  id: string
  /** 优先级：数值大者先试。 */
  priority: number
  match(ref: FieldRef): boolean
  read(ctx: ControlContext): string
  write(ctx: ControlContext, value: string): Promise<WriteAttempt>
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
      if (levels.length > 1 && list) return stepThroughOptions(list, value, null)
      return { applied: false, reasonCode: 'no-matching-option' }
    }
    const option = options[match.index]
    option.selected = true
    select.selectedIndex = match.index
    setNativeSelect(select, option.value)
    revealHiddenSelectOption(select, option.text)
    if (ctx.ref.kind === 'cascade') await wait(200) // 等待级联下一级刷新
    return { applied: true }
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
  if (match.index < 0 || match.ambiguous || !items[match.index]) return false
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
      if (match.index < 0 || match.ambiguous || !nodes[match.index]) {
        return { applied: false, reasonCode: 'no-matching-option' }
      }
      const target = nodes[match.index]
      if (target instanceof HTMLInputElement) return { applied: activateRadio(target) }
      clickElement(target)
      target.setAttribute('aria-checked', 'true')
      for (const other of nodes) {
        if (other !== target) other.setAttribute('aria-checked', 'false')
      }
      return { applied: true }
    }
    const checkboxes = ref.checkboxes || [ref.element as HTMLInputElement]
    if (checkboxes.length === 1) {
      const target = booleanValue(value)
      if (target === null) return { applied: false, reasonCode: 'no-matching-option' }
      const checkbox = checkboxes[0]
      if (checkbox.checked !== target) checkbox.click()
      dispatchFieldEvents(checkbox)
      return { applied: checkbox.checked === target }
    }
    const requested = splitMulti(value)
    if (!requested.length) return { applied: false, reasonCode: 'no-matching-option' }
    for (const checkbox of checkboxes) {
      const label = optionLabel(checkbox) || checkbox.value
      const target = requested.some(item => matchOption([label], item).index === 0)
      if (checkbox.checked !== target) checkbox.click()
      dispatchFieldEvents(checkbox)
    }
    return { applied: checkboxes.some(checkbox => checkbox.checked) }
  }
}

// ─── 组件库日期 picker（ant-picker / el-date-editor，F11）────

function innerInput(element: HTMLElement): HTMLInputElement | null {
  if (element instanceof HTMLInputElement) return element
  return element.querySelector<HTMLInputElement>('input')
}

const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const PREV_YEAR = '.ant-picker-header-super-prev-btn,.el-picker-panel__icon-btn.d-arrow-left,.el-date-picker__prev-btn.el-icon-d-arrow-left'
const NEXT_YEAR = '.ant-picker-header-super-next-btn,.el-picker-panel__icon-btn.d-arrow-right,.el-date-picker__next-btn.el-icon-d-arrow-right'
const PREV_MONTH = '.ant-picker-header-prev-btn,.el-picker-panel__icon-btn.arrow-left,.el-date-picker__prev-btn.el-icon-arrow-left'
const NEXT_MONTH = '.ant-picker-header-next-btn,.el-picker-panel__icon-btn.arrow-right,.el-date-picker__next-btn.el-icon-arrow-right'

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
  if (!year) return null
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
  const inner = cell.querySelector<HTMLElement>('.ant-picker-cell-inner,.el-date-table-cell,.el-date-table-cell__text,span') || cell
  clickElement(inner)
}

function findDayCell(popup: HTMLElement, day: number): HTMLElement | null {
  const cells = Array.from(popup.querySelectorAll<HTMLElement>('.ant-picker-cell-in-view,.el-date-table td.available,.el-date-table td'))
  return cells.find(cell => {
    const className = `${cell.className} ${cell.parentElement?.className || ''}`
    if (/disabled|prev-month|next-month/.test(className)) return false
    const text = (cell.querySelector('.ant-picker-cell-inner,span') || cell).textContent?.trim()
    return text === String(day)
  }) || null
}

function findMonthCell(popup: HTMLElement, year: number, month: number): HTMLElement | null {
  const title = `${year}-${String(month).padStart(2, '0')}`
  const titled = popup.querySelector<HTMLElement>(`[title="${title}"]`)
  if (titled) return titled
  const labels = [String(month), `${month}月`, MONTH_NAMES[month - 1]].filter(Boolean)
  const cells = Array.from(popup.querySelectorAll<HTMLElement>('.ant-picker-cell,.el-month-table td,.el-month-table .cell'))
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
  const host = element.closest('.ant-picker-range,.el-range-editor,.el-date-editor--daterange,.el-date-editor--monthrange')
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
    const library = Boolean(input.closest('.ant-picker,.el-date-editor,.arco-picker,.ivu-date-picker,.n-date-picker,[class*="date-picker"],[class*="datepicker"],[class*="time-picker"]'))
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
      clickElement(input.closest('.ant-picker,.el-date-editor,.arco-picker') || input)
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
const MAX_SCROLL_ATTEMPTS = 6

async function loadMoreOptions(popup: HTMLElement): Promise<void> {
  const marked = popup.querySelector<HTMLElement>('.rc-virtual-list-holder,.el-scrollbar__wrap,.arco-virtual-list,.semi-select-option-list')
  const scroller = marked || Array.from(popup.querySelectorAll<HTMLElement>('*')).find(node => node.scrollHeight > node.clientHeight + 24)
  if (!scroller) return
  scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(scroller.clientHeight, 120))
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  await wait(180)
}

const comboboxRecognizer: ControlRecognizer = {
  id: 'custom-combobox',
  priority: 8,
  settleTimeoutMs: 2500,
  match: ref => ref.kind === 'combobox' || ref.kind === 'multiselect' && !(ref.element instanceof HTMLSelectElement),
  read: ctx => readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const trigger = ctx.ref.element
    const watch = watchForPopup(trigger)
    try {
      const clickable = trigger.querySelector<HTMLElement>('.ant-select-selector,.el-select__wrapper,.el-input__wrapper,.el-input,.arco-select-view,.n-base-selection,.ivu-select-selection,.semi-select-selection,.t-select__wrap,.t-input__wrap') || trigger
      clickElement(clickable)
      const input = trigger instanceof HTMLInputElement ? trigger : trigger.querySelector<HTMLInputElement>('input:not([type="hidden"])')
      const popup = await watch.locate()
      if (!popup) return { applied: false, reasonCode: 'option-list-not-found' }

      if (shouldStepCascade(value)) {
        if (!realOptions(popupOptions(popup)).length) return { applied: false, reasonCode: 'option-list-not-found', detail: '选项尚未出现' }
        return stepThroughOptions(popup, value, input)
      }

      // 输入筛选 → 滚动加载 → 重查（虚拟列表只渲染视口内的选项）
      let scrolled = 0
      for (let attempt = 0; attempt < MAX_FILTER_ATTEMPTS + MAX_SCROLL_ATTEMPTS; attempt += 1) {
        const options = popupOptions(popup)
        const texts = options.map(option => optionText(option))
        const match = matchOption(texts, value)
        if (match.index >= 0 && !match.ambiguous) {
          const option = options[match.index]
          option.scrollIntoView?.({ block: 'nearest' })
          clickElement(option)
          await wait(120)
          return { applied: true }
        }
        if (match.ambiguous) return { applied: false, reasonCode: 'no-matching-option', detail: '选项存在多个匹配' }
        // 尝试输入筛选后重查
        if (input && !input.readOnly && attempt < MAX_FILTER_ATTEMPTS - 1) {
          setNativeText(input, attempt === 0 ? value : value.slice(0, Math.max(1, value.length - attempt)))
          await wait(320)
        } else if (scrolled < MAX_SCROLL_ATTEMPTS) {
          scrolled += 1
          await loadMoreOptions(popup)
        } else {
          break
        }
      }
      return { applied: false, reasonCode: 'no-matching-option' }
    } finally {
      watch.dispose()
    }
  },
  async restore(ctx, previous) {
    const trigger = ctx.ref.element
    const host = trigger.closest<HTMLElement>('.ant-select,.el-select,.arco-select') || trigger
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

const cascaderRecognizer: ControlRecognizer = {
  id: 'custom-cascader',
  priority: 9,
  settleTimeoutMs: 3000,
  match: ref => ref.kind === 'cascade' && !(ref.element instanceof HTMLSelectElement),
  read: ctx => readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const trigger = ctx.ref.element
    const watch = watchForPopup(trigger)
    const rollback = async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      const host = trigger.closest<HTMLElement>('.ant-cascader,.el-cascader') || trigger
      const clear = host.querySelector<HTMLElement>('.ant-select-clear,.el-input__clear,[class*="clear"]')
      if (clear) clickElement(clear)
      await wait(100)
    }
    try {
      clickElement(trigger)
      const popup = await watch.locate()
      if (!popup) return { applied: false, reasonCode: 'option-list-not-found' }
      const input = trigger instanceof HTMLInputElement ? trigger : trigger.querySelector<HTMLInputElement>('input:not([type="hidden"])')
      if (!realOptions(popupOptions(popup)).length) return { applied: false, reasonCode: 'option-list-not-found', detail: '选项尚未出现' }
      const stepped = await stepThroughOptions(popup, value, input)
      if (!stepped.applied) await rollback()
      return stepped
    } finally {
      watch.dispose()
    }
  },
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
  const matched = RECOGNIZERS.filter(recognizer => recognizer.match(ref))
  if (!matched.length) return null
  return matched.sort((a, b) => b.priority - a.priority)[0]
}
