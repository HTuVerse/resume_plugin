import type { FillReasonCode } from '../../../domain/types'
import type { FieldRef } from '../scan/collector'
import { readCurrentValue } from '../scan/collector'
import { matchOption } from '../../ontology/optionMatch'
import { booleanValue } from '../../ontology/synonyms'
import { normalizeDateValue } from '../../ontology/validators'
import { optionLabel } from '../scan/labelResolver'
import { dispatchFieldEvents, isElementVisible, pollUntil, setNativeChecked, setNativeSelect, setNativeText, wait } from './domUtils'
import { popupOptions, watchForPopup } from './popupLocator'

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
    if (element.isContentEditable) {
      element.textContent = value
      dispatchFieldEvents(element)
      return { applied: true }
    }
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
    if (match.index < 0) return { applied: false, reasonCode: 'no-matching-option' }
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

/** 原生 select 被藏起来时，旁边的自定义列表不会跟着 value 变，要点可见项。 */
function revealHiddenSelectOption(select: HTMLSelectElement, label: string): void {
  const style = getComputedStyle(select)
  if (style.display !== 'none' && style.visibility !== 'hidden') return
  const host = select.parentElement
  const list = host?.querySelector<HTMLElement>('ul,[role="listbox"],[class*="dropdown"],[class*="options"]')
  if (!list) return
  const items = Array.from(list.querySelectorAll<HTMLElement>('li,[role="option"]'))
  const match = matchOption(items.map(item => item.textContent?.trim() || ''), label)
  if (match.index >= 0 && !match.ambiguous && items[match.index]) clickElement(items[match.index])
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

function activateRadio(radio: HTMLInputElement): boolean {
  const wrapper = radio.closest('label,.el-radio,.el-radio-button,.ant-radio-wrapper,.ant-radio-button-wrapper,.arco-radio,[role="radio"]') as HTMLElement | null
  const visible = wrapper?.querySelector<HTMLElement>('.el-radio__inner,.el-radio-button__inner,.ant-radio-inner,.ant-radio-button,.arco-radio-mask,.el-radio__label') || wrapper
  if (visible) clickElement(visible)
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
      target.click()
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

/** 打开面板后点中对应的日、月或时刻。点不到时返回 false，交给输入框兜底。 */
async function chooseInPicker(popup: HTMLElement, value: string, input: HTMLInputElement): Promise<boolean> {
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

const MAX_FILTER_ATTEMPTS = 3

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
      const clickable = trigger.querySelector<HTMLElement>('.ant-select-selector,.el-select__wrapper,.el-input__wrapper,.el-input,.arco-select-view,.n-base-selection,.ivu-select-selection') || trigger
      clickElement(clickable)
      const input = trigger instanceof HTMLInputElement ? trigger : trigger.querySelector<HTMLInputElement>('input:not([type="hidden"])')
      const popup = await watch.locate()
      if (!popup) return { applied: false, reasonCode: 'option-list-not-found' }

      // 输入筛选 → 重查 循环（对付虚拟滚动长列表）
      for (let attempt = 0; attempt < MAX_FILTER_ATTEMPTS; attempt += 1) {
        const options = popupOptions(popup)
        const texts = options.map(option => option.textContent?.trim() || '')
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

// ─── 自定义级联（cascader，F12）─────────────────────────────

/** 值按分隔符 / 行政区后缀智能拆分为层级数组。 */
export function splitCascadeValue(value: string): string[] {
  const bySeparator = value.split(/\s*[\/>»→\-—、,，]\s*/).map(item => item.trim()).filter(Boolean)
  if (bySeparator.length > 1) return bySeparator
  // 无显式分隔：按 省/市/区/县/旗/盟 后缀切
  const byRegion = value.match(/[^省市区县旗盟]+?(?:省|市|区|县|旗|盟|自治区|自治州|自治县)/g)
  if (byRegion && byRegion.length > 1) return byRegion.map(item => item.trim())
  return [value.trim()]
}

const CASCADER_COLUMN_SELECTOR = '.ant-cascader-menu,.el-cascader-menu,.arco-cascader-panel-column,[class*="cascader"] ul,[role="menu"]'
const CASCADER_OPTION_SELECTOR = '.ant-cascader-menu-item:not(.ant-cascader-menu-item-disabled),.el-cascader-node:not(.is-disabled),.arco-cascader-option,[role="menuitemcheckbox"],[role="menuitem"],li'

function cascaderColumns(popup: HTMLElement): HTMLElement[] {
  const columns = Array.from(popup.querySelectorAll<HTMLElement>(CASCADER_COLUMN_SELECTOR)).filter(isElementVisible)
  return columns.filter(column => !columns.some(other => other !== column && column.contains(other)))
}

function columnOptions(column: HTMLElement): HTMLElement[] {
  const options = Array.from(column.querySelectorAll<HTMLElement>(CASCADER_OPTION_SELECTOR)).filter(isElementVisible)
  return options.filter(option => !options.some(other => other !== option && option.contains(other)))
}

const cascaderRecognizer: ControlRecognizer = {
  id: 'custom-cascader',
  priority: 9,
  settleTimeoutMs: 3000,
  match: ref => ref.kind === 'cascade' && !(ref.element instanceof HTMLSelectElement),
  read: ctx => readCurrentValue(ctx.ref),
  async write(ctx, value) {
    const trigger = ctx.ref.element
    const levels = splitCascadeValue(value)
    const watch = watchForPopup(trigger)
    const rollback = async () => {
      // 不留半成品：按 Escape 收起，再尝试点清除按钮
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

      for (let level = 0; level < levels.length; level += 1) {
        // 轮询等待第 level 列出现（不用固定 sleep）
        const column = await pollUntil(() => {
          const columns = cascaderColumns(popup.isConnected ? popup : document.body)
          return columns.length > level ? columns[level] : (columns.length ? columns[columns.length - 1] : null)
        }, 1500)
        if (!column) {
          await rollback()
          return { applied: false, reasonCode: 'option-list-not-found', detail: `第 ${level + 1} 级选项未出现` }
        }
        const options = columnOptions(column)
        const texts = options.map(option => option.textContent?.trim() || '')
        const match = matchOption(texts, levels[level])
        if (match.index < 0 || match.ambiguous) {
          await rollback()
          return { applied: false, reasonCode: 'no-matching-option', detail: `第 ${level + 1} 级找不到「${levels[level]}」` }
        }
        clickElement(options[match.index])
        await wait(160)
      }
      await wait(150)
      return { applied: true }
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
