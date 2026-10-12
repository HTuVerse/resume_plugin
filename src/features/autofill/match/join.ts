import type { SlotDef } from '../../../domain/slots'
import type { FillReasonCode, FormField } from '../../../domain/types'
import { isPlaceholderOption, matchOption } from '../../ontology/optionMatch'
import { isOngoingDate, normalizeEnumValue, splitOngoingRange, validateType } from '../../ontology/validators'
import { splitCascadeValue } from '../write/recognizers'

/**
 * 值域校验与归一化管线（F04/F05，硬闸门，TECH_DESIGN §6）。
 *
 * 这是错填率的唯一硬约束点。打分只决定「是否进入自动填写候选」，
 * 本闸门决定「是否真的写入」。AI 结果、站点规则命中、用户手工指定
 * 都必须经过——任何绕过校验的通路都是设计缺陷。
 */

export type GateOutcome =
  | { ok: true; value: string; needsConfirmation: false }
  | { ok: true; value: string; needsConfirmation: true; reason: string; reasonCode: FillReasonCode | 'value-truncated' }
  | { ok: false; reason: string; reasonCode: FillReasonCode }

export function gateValue(slot: SlotDef | undefined, field: FormField, rawValue: string): GateOutcome {
  const raw = String(rawValue || '').trim()
  if (!raw) return { ok: false, reason: '候选值为空', reasonCode: 'rejected-by-validation' }

  // 1. 类型校验 + 2. 归一化
  let value = raw
  if (slot) {
    const checked = validateType(slot.valueType, raw)
    if (!checked.ok) {
      return { ok: false, reason: `值类型校验未通过：${checked.reason}`, reasonCode: 'rejected-by-validation' }
    }
    value = checked.value
    // 区间选择器要同时留下起止；普通年月字段仍只用校验后的第一段。
    const range = field.range ? splitOngoingRange(raw) : null
    if (range?.start && range.end && (slot.valueType === 'date' || slot.valueType === 'month' || isOngoingDate(range.end))) {
      value = raw
    }

    // 3. 枚举值域校验（valueType === 'enum' 时为硬校验）
    if (slot.valueType === 'enum') {
      const inDomain = normalizeEnumValue(slot, value)
      if (!inDomain) {
        return { ok: false, reason: `「${value}」不在 ${slot.aliases[0]} 的标准值域内`, reasonCode: 'rejected-by-validation' }
      }
      value = inDomain
    }
  }

  // 4. 选项可达性校验。下拉和级联与原生 select 同一套匹配。
  // 静态扫描读不到选项时，不在这里拦住明确字段。真正写入时会展开控件、
  // 只点击唯一匹配项并回读确认；找不到或有歧义仍会失败，不会猜填。
  // 这也让依赖上游字段、稍后才加载选项的原生 select 能进入延迟填写队列。
  if (['select', 'multiselect', 'radio', 'checkbox', 'combobox', 'cascade'].includes(field.kind)) {
    const usable = field.options.filter(option => option.trim() && !isPlaceholderOption(option))
    if (!usable.length) return { ok: true, value, needsConfirmation: false }
    const complete = field.optionCoverage === 'complete'
      || (field.optionCoverage == null && ['select', 'radio', 'checkbox'].includes(field.kind))
    const values = field.kind === 'multiselect' || field.kind === 'checkbox'
      ? value.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
      : field.kind === 'cascade'
        ? splitCascadeValue(value)
        : [value]
    let converted: { from: string; to: string } | null = null
    let weakConversion = false
    const matched: string[] = []
    for (const single of values) {
      const match = matchOption(field.options, single)
      if (match.index < 0) {
        // 自定义下拉、虚拟列表和联动控件通常只暴露当前渲染片段。
        // 只有已证明完整的选项集，才有资格在执行前断言目标不存在。
        if (complete) return { ok: false, reason: `完整选项集中找不到「${single}」的唯一匹配`, reasonCode: 'no-matching-option' }
        matched.push(single)
        continue
      }
      if (match.ambiguous) {
        return { ok: true, value, needsConfirmation: true, reason: `「${single}」在选项集中有多个匹配，请确认`, reasonCode: 'needs-confirmation' }
      }
      matched.push(field.options[match.index])
      if (match.reason !== 'exact') {
        converted = { from: single, to: field.options[match.index] }
        if (match.reason === 'prefix') weakConversion = true
      }
    }
    // 维护词典中的唯一同义值和有序等级映射是确定性转换，可直接进入执行层，
    // 最终仍由写入后的页面回读负责兜底。前缀匹配语义更弱，继续要求确认。
    if (converted) {
      if (values.length === 1) value = converted.to
      else if (field.kind === 'cascade') value = matched.join(' / ')
      else if (field.kind === 'multiselect' || field.kind === 'checkbox') value = matched.join('、')
      if (!weakConversion) {
        return { ok: true, value, needsConfirmation: false }
      }
      return {
        ok: true, value, needsConfirmation: true,
        reason: `「${converted.from}」已按同义值转换为选项「${converted.to}」，请确认`,
        reasonCode: 'needs-confirmation'
      }
    }
  }

  // 5. 长度校验：超长不静默截断，转待确认
  if (field.maxLength > 0 && value.length > field.maxLength) {
    return {
      ok: true,
      value: value.slice(0, field.maxLength),
      needsConfirmation: true,
      reason: `内容超出页面限制（${value.length}/${field.maxLength} 字），已按限制截断，请确认`,
      reasonCode: 'value-truncated'
    }
  }

  return { ok: true, value, needsConfirmation: false }
}
