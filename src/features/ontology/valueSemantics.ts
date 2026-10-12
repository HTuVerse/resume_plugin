import type { SlotDef } from '../../domain/slots'
import type { FormField } from '../../domain/types'
import { normalize } from '../../shared/normalize'
import { sameValue } from './synonyms'
import { compareProjectedSequence } from '../autofill/valueProjection'

/**
 * existing 为知识库/原值，observed 为网页/新值。
 * compatible 表示网页精度较低但不冲突；enrichment 表示新值信息更完整。
 */
export type SemanticValueRelation = 'equal' | 'compatible' | 'enrichment' | 'different'

export interface ValueSemanticContext {
  slot?: SlotDef
  field?: Pick<FormField, 'kind' | 'valueBinding'>
}

interface DateParts {
  year: number
  month?: number
  day?: number
  precision: 1 | 2 | 3
}

function slotAliasValue(slot: SlotDef | undefined, value: string): string {
  const key = normalize(value)
  if (!key) return ''
  for (const group of slot?.valueAliases || []) {
    if (group.some(alias => normalize(alias) === key)) return normalize(group[0])
  }
  return key
}

function dateParts(value: string): DateParts | null {
  const match = value.trim().match(/((?:19|20)\d{2})(?:\D{0,3}(0?[1-9]|1[0-2]))?(?:\D{0,3}(0?[1-9]|[12]\d|3[01]))?/)
  if (!match) return null
  const month = match[2] ? Number(match[2]) : undefined
  const day = match[3] ? Number(match[3]) : undefined
  return { year: Number(match[1]), month, day, precision: day ? 3 : month ? 2 : 1 }
}

function dateRelation(existing: string, observed: string, monthOnly: boolean): SemanticValueRelation {
  const left = dateParts(existing)
  const right = dateParts(observed)
  if (!left || !right) return normalize(existing) === normalize(observed) ? 'equal' : 'different'
  if (left.year !== right.year) return 'different'
  if (left.month !== undefined && right.month !== undefined && left.month !== right.month) return 'different'
  if (!monthOnly && left.day !== undefined && right.day !== undefined && left.day !== right.day) return 'different'
  const leftPrecision = monthOnly ? Math.min(left.precision, 2) : left.precision
  const rightPrecision = monthOnly ? Math.min(right.precision, 2) : right.precision
  if (leftPrecision === rightPrecision) return 'equal'
  return leftPrecision > rightPrecision ? 'compatible' : 'enrichment'
}

function normalizedUrl(value: string): string {
  const text = value.trim()
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}${url.hash}`
  } catch {
    return normalize(text)
  }
}

function collectionValues(value: string): string[] {
  return value.split(/[,，、|/]/).map(item => normalize(item)).filter(Boolean).sort()
}

/** 全项目统一的槽位感知值比较。业务层不得再直接用字符串相等判断字段是否变化。 */
export function compareSemanticValues(existing: string, observed: string, context: ValueSemanticContext = {}): SemanticValueRelation {
  const left = String(existing || '').trim()
  const right = String(observed || '').trim()
  if (!left || !right) return left === right ? 'equal' : 'different'
  if (left === right) return 'equal'

  const { slot, field } = context
  if (field?.valueBinding?.shape === 'sequence') return compareProjectedSequence(left, right)
  if (slot?.valueType === 'date' || slot?.valueType === 'month' || field?.kind === 'date') {
    return dateRelation(left, right, slot?.valueType === 'month')
  }
  if (slot?.valueType === 'phone') {
    return left.replace(/\D/g, '') === right.replace(/\D/g, '') ? 'equal' : 'different'
  }
  if (slot?.valueType === 'email') return left.toLowerCase() === right.toLowerCase() ? 'equal' : 'different'
  if (slot?.valueType === 'number') {
    const a = Number(left.replace(/[^\d.+-]/g, ''))
    const b = Number(right.replace(/[^\d.+-]/g, ''))
    return Number.isFinite(a) && Number.isFinite(b) && a === b ? 'equal' : 'different'
  }
  if (slot?.valueType === 'url') return normalizedUrl(left) === normalizedUrl(right) ? 'equal' : 'different'
  if (field?.kind === 'multiselect' || field?.kind === 'checkbox') {
    return JSON.stringify(collectionValues(left)) === JSON.stringify(collectionValues(right)) ? 'equal' : 'different'
  }

  const aliasLeft = slotAliasValue(slot, left)
  const aliasRight = slotAliasValue(slot, right)
  if (aliasLeft === aliasRight) return 'equal'
  if (slot?.valueType === 'enum' || slot?.valueType === 'boolean' || slot?.enumValues?.length) {
    return sameValue(left, right) ? 'equal' : 'different'
  }
  return normalize(left) === normalize(right) ? 'equal' : 'different'
}

export function semanticValuesMatch(existing: string, observed: string, context: ValueSemanticContext = {}): boolean {
  const relation = compareSemanticValues(existing, observed, context)
  return relation === 'equal' || relation === 'compatible'
}
