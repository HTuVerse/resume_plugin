import type { FormField } from '../../../domain/types'
import { isPlaceholderOption } from '../../ontology/optionMatch'
import type { FieldRef } from './collector'
import { OPTION_SELECTOR, watchForPopup } from '../write/popupLocator'
import { isElementVisible, wait } from '../write/domUtils'

const MAX_PROBES = 16
const PROBE_TIMEOUT = 280
/** 性别、学历这类枚举经常排在长表后面，空下拉优先展开它们。 */
const ENUM_PROBE_LABEL = /性别|学历|学位|民族|政治|婚姻/

export function choiceProbeRank(field: FormField): number {
  const text = `${field.label} ${field.placeholder} ${field.nearbyText || ''}`
  return ENUM_PROBE_LABEL.test(text) ? 0 : 1
}

export function orderedChoiceProbes(fields: FormField[]): FormField[] {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => choiceProbeRank(a.field) - choiceProbeRank(b.field) || a.index - b.index)
    .map(item => item.field)
}

function click(element: HTMLElement): void {
  const options: MouseEventInit = { bubbles: true, cancelable: true }
  element.dispatchEvent(new MouseEvent('pointerdown', options))
  element.dispatchEvent(new MouseEvent('mousedown', options))
  element.click()
}

function safeToProbe(element: HTMLElement): boolean {
  const popupType = element.getAttribute('aria-haspopup')
    || element.querySelector('[aria-haspopup]')?.getAttribute('aria-haspopup')
  if (popupType === 'dialog') return false
  return Boolean(
    element.matches('[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="tree"],[aria-haspopup="menu"]')
    || element.querySelector('[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="tree"],[aria-haspopup="menu"]')
    || element.closest('.ant-select,.el-select,.arco-select,.n-select,.ivu-select,.semi-select,.t-select,.ant-cascader,.el-cascader,.arco-cascader')
  )
}

async function closePopup(element: HTMLElement, popup: HTMLElement | null): Promise<void> {
  const escape = () => new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  const input = element instanceof HTMLInputElement ? element : element.querySelector<HTMLElement>('input,[role="combobox"]')
  input?.dispatchEvent(escape())
  element.dispatchEvent(escape())
  document.dispatchEvent(escape())
  window.dispatchEvent(escape())
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  await wait(40)
  if (!popup?.isConnected || !isElementVisible(popup)) {
    // 浮层定位器可能认不出站点自定义的 dialog；仍先发一次外部点击，
    // 避免探测动作把一个无法识别的弹层遗留在页面上。
    document.body.click()
    return
  }

  // 部分组件不响应合成 Escape，但会响应外部点击。
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  document.body.click()
  await wait(40)
  if (!popup.isConnected || !isElementVisible(popup)) return

  // 最后按开关语义再点一次；写入器也能识别仍然展开的浮层，不会反向关掉。
  click(element)
  await wait(40)
}

/**
 * 下拉没打开时选项是空的，选项反推用不上。
 * 识别时短暂展开、读可见选项、再关掉。最多试 16 个，性别和学历优先，打不开就跳过。
 */
export async function probeEmptyChoiceOptions(fields: FormField[], refs: Map<string, FieldRef>): Promise<void> {
  let probed = 0
  for (const field of orderedChoiceProbes(fields)) {
    if (probed >= MAX_PROBES) break
    if (!['combobox', 'multiselect', 'cascade'].includes(field.kind)) continue
    const ready = field.options.filter(option => option.trim() && !isPlaceholderOption(option))
    if (ready.length >= 2) continue
    const ref = refs.get(field.fingerprint)
    if (!ref?.element.isConnected) continue
    if (!safeToProbe(ref.element)) continue
    probed += 1
    const watch = watchForPopup(ref.element)
    let popup: HTMLElement | null = null
    try {
      click(ref.element)
      popup = await watch.locate(PROBE_TIMEOUT)
      if (!popup) continue
      const texts = Array.from(popup.querySelectorAll<HTMLElement>(OPTION_SELECTOR))
        .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(text => text && text.length < 40 && !isPlaceholderOption(text))
      const unique = [...new Set(texts)].slice(0, 40)
      if (unique.length >= 2) field.options = unique
    } catch {
      /* 这个控件打不开，继续扫别的 */
    } finally {
      await closePopup(ref.element, popup)
      watch.dispose()
    }
  }
}
