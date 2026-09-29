import type { SlotDef } from '../../../domain/slots'
import type { FillReasonCode, FormField } from '../../../domain/types'
import { matchOption } from '../../ontology/optionMatch'
import { normalizeEnumValue, validateType } from '../../ontology/validators'

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

    // 3. 枚举值域校验（valueType === 'enum' 时为硬校验）
    if (slot.valueType === 'enum') {
      const inDomain = normalizeEnumValue(slot, value)
      if (!inDomain) {
        return { ok: false, reason: `「${value}」不在 ${slot.aliases[0]} 的标准值域内`, reasonCode: 'rejected-by-validation' }
      }
      value = inDomain
    }
  }

  // 4. 选项可达性校验（字段有选项集时）
  if (field.options.length && ['select', 'multiselect', 'radio', 'checkbox'].includes(field.kind)) {
    const values = field.kind === 'multiselect' || field.kind === 'checkbox'
      ? value.split(/[,，、|/]/).map(item => item.trim()).filter(Boolean)
      : [value]
    let converted: { from: string; to: string } | null = null
    for (const single of values) {
      const match = matchOption(field.options, single)
      if (match.index < 0) {
        return { ok: false, reason: `选项集中找不到「${single}」的唯一匹配`, reasonCode: 'no-matching-option' }
      }
      if (match.ambiguous) {
        return { ok: true, value, needsConfirmation: true, reason: `「${single}」在选项集中有多个匹配，请确认`, reasonCode: 'needs-confirmation' }
      }
      if (match.reason !== 'exact') converted = { from: single, to: field.options[match.index] }
    }
    // 非全等命中（同义/等级/前缀）：给出转换后的待确认候选，不直接填入（PRD F04 验收）
    if (converted) {
      if (values.length === 1) value = converted.to
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
