import type { FormField } from '../../../domain/types'
import { isPlaceholderOption } from '../../ontology/optionMatch'
import { readCurrentValue, type FieldRef } from './collector'
import { probeControlBehavior } from '../control/behaviorProbe'
import { fieldKindFromUniversalType, inferCapabilities, universalTypeFromFieldKind, type UniversalControl } from '../control/model'

const MAX_PROBES = 16
const PROBE_TIMEOUT = 480
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

function controlFor(field: FormField, ref: FieldRef): UniversalControl {
  if (ref.control) return ref.control
  const type = universalTypeFromFieldKind(ref.kind, field.options.length)
  const control: UniversalControl = {
    fingerprint: field.fingerprint,
    type,
    element: ref.element,
    label: field.label,
    labelSource: field.labelSource || 'none',
    currentValue: field.current,
    options: field.options.map((label, index) => ({ id: `known-${index + 1}`, label, disabled: false, selected: false })),
    optionCoverage: field.optionCoverage || 'unknown',
    capabilities: inferCapabilities(ref.element, type),
    sectionId: field.sectionId,
    repeatIndex: field.item,
    confidence: 0.7,
    evidence: [`classifier:${field.kind}`]
  }
  ref.control = control
  return control
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
    try {
      const result = await probeControlBehavior(controlFor(field, ref), () => readCurrentValue(ref), PROBE_TIMEOUT)
      if (!result.confirmed) continue
      const refinedKind = fieldKindFromUniversalType(result.type)
      if (['combobox', 'multiselect', 'cascade', 'date'].includes(refinedKind)) {
        field.kind = refinedKind
        ref.kind = refinedKind
      }
      const unique = [...new Set(result.options.map(option => option.label)
        .filter(text => text && text.length < 40 && !isPlaceholderOption(text)))].slice(0, 40)
      if (unique.length >= 2) {
        field.options = unique
        field.optionCoverage = result.optionCoverage
      }
    } catch {
      /* 这个控件打不开，继续扫别的 */
    }
  }
}
