import type { FormField } from '../../../domain/types'
import { isPlaceholderOption } from '../../ontology/optionMatch'
import type { FieldRef } from './collector'
import { OPTION_SELECTOR, watchForPopup } from '../write/popupLocator'

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

function closePopup(element: HTMLElement): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
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
    probed += 1
    const watch = watchForPopup(ref.element)
    try {
      click(ref.element)
      const popup = await watch.locate(PROBE_TIMEOUT)
      if (!popup) continue
      const texts = Array.from(popup.querySelectorAll<HTMLElement>(OPTION_SELECTOR))
        .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(text => text && text.length < 40 && !isPlaceholderOption(text))
      const unique = [...new Set(texts)].slice(0, 40)
      if (unique.length >= 2) field.options = unique
    } catch {
      /* 这个控件打不开，继续扫别的 */
    } finally {
      closePopup(ref.element)
      watch.dispose()
    }
  }
}
