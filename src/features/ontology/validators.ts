import type { SlotDef, SlotValueType } from '../../domain/slots'
import { booleanValue, canonicalValue, sameValue } from './synonyms'
import { semanticValuesMatch } from './valueSemantics'

/**
 * 值类型校验与归一化（F04，硬闸门第 1/2 步）。
 * 打分只决定「是否进入候选」，本模块决定「值本身是否合法」。
 */

export interface TypeCheckResult {
  ok: boolean
  /** 归一化后的值（校验通过时）。 */
  value: string
  reason?: string
}

const PHONE_PATTERN = /^1[3-9]\d{9}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const ONGOING_DATE = /^(至今|现在|目前|在读|present|now|current)$/i

/** 结束时间写成「至今 / 现在」，不是一个可解析的年月日。 */
export function isOngoingDate(value: string): boolean {
  return ONGOING_DATE.test(value.trim())
}

/**
 * 区间选择器上的一对端点。
 * 「2021-09至今」保留结束端；纯「至今」只有结束端；两个年份才拆成起止。
 */
export function splitOngoingRange(value: string): { start: string; end: string } | null {
  const text = value.trim()
  const marked = text.match(/^(.*?)(?:至|到|[-–—~～])?\s*(至今|现在|目前|在读|present|now|current)$/i)
  if (marked?.[1].trim()) return { start: marked[1].trim(), end: marked[2] }
  if (isOngoingDate(text)) return { start: '', end: text }
  const parts = splitDateRange(text)
  if (parts.length >= 2) return { start: parts[0], end: parts[1] }
  return null
}

/**
 * 把「2021.9-2025.6」「2021年9月至2025年6月」这类区间串拆成独立日期串。
 * 只有当分隔符后紧跟年份时才视为区间分隔，避免误拆「2021-09」。
 */
export function splitDateRange(value: string): string[] {
  const parts = value.trim().split(/\s*(?:[-–—~～]|至|到)\s*(?=(?:19|20)\d{2})/).filter(Boolean)
  return parts.length ? parts : [value.trim()]
}

/**
 * 日期归一化（加固版）：先按区间拆分取首个日期，再抽取年月日。
 * monthOnly 时输出 YYYY-MM，否则 YYYY-MM-DD（缺日默认 01）。
 */
export function normalizeDateValue(value: string, monthOnly: boolean): string {
  const first = splitDateRange(value)[0] || value.trim()
  const parts = first.match(/((?:19|20)\d{2})\D{0,3}(0?[1-9]|1[0-2])(?!\d)(?:\D{0,3}(0?[1-9]|[12]\d|3[01])(?!\d))?/)
  if (!parts) {
    // 只有年份的情况（如「2024」「2024年」）
    const yearOnly = first.match(/^((?:19|20)\d{2})\s*年?$/)
    if (yearOnly) return monthOnly ? `${yearOnly[1]}-01` : `${yearOnly[1]}-01-01`
    return first
  }
  const year = parts[1]
  const month = parts[2].padStart(2, '0')
  if (monthOnly) return `${year}-${month}`
  return `${year}-${month}-${(parts[3] || '01').padStart(2, '0')}`
}

function isParseableDate(value: string): boolean {
  const normalized = normalizeDateValue(value, false)
  return /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(normalized)
}

function extractNumber(value: string): string {
  const match = value.trim().match(/-?\d+(?:\.\d+)?/)
  return match ? match[0] : ''
}

/**
 * 类型校验与归一化（闸门第 1/2 步合并实现）。
 * 失败 → { ok: false, reason: 'type-mismatch' 描述 }。
 */
export function validateType(valueType: SlotValueType, value: string): TypeCheckResult {
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, value: '', reason: '值为空' }
  switch (valueType) {
    case 'phone': {
      const digits = trimmed.replace(/[\s\-()]/g, '')
      return PHONE_PATTERN.test(digits)
        ? { ok: true, value: digits }
        : { ok: false, value: trimmed, reason: '不是合法的手机号' }
    }
    case 'email':
      return EMAIL_PATTERN.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, value: trimmed, reason: '不是合法的邮箱地址' }
    case 'date':
      if (isOngoingDate(trimmed)) return { ok: true, value: trimmed }
      return isParseableDate(trimmed)
        ? { ok: true, value: normalizeDateValue(trimmed, false) }
        : { ok: false, value: trimmed, reason: '无法解析为合法日期' }
    case 'month': {
      if (isOngoingDate(trimmed)) return { ok: true, value: trimmed }
      const normalized = normalizeDateValue(trimmed, true)
      return /^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(normalized)
        ? { ok: true, value: normalized }
        : { ok: false, value: trimmed, reason: '无法解析为年月' }
    }
    case 'number': {
      const number = extractNumber(trimmed)
      return number
        ? { ok: true, value: number }
        : { ok: false, value: trimmed, reason: '不是数字' }
    }
    case 'boolean': {
      const parsed = booleanValue(trimmed)
      return parsed === null
        ? { ok: false, value: trimmed, reason: '不是「是 / 否」类的值' }
        : { ok: true, value: parsed ? '是' : '否' }
    }
    case 'url':
      return /^https?:\/\/\S+$/i.test(trimmed) || /^[\w-]+(\.[\w-]+)+\S*$/.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, value: trimmed, reason: '不是合法的网址' }
    case 'enum':
    case 'text':
    case 'longtext':
    default:
      return { ok: true, value: trimmed }
  }
}

/**
 * 枚举值域校验（闸门第 3 步）：归一化后的值必须能对应到 slot.enumValues 之一。
 * 返回值域内的标准值；不在值域内返回 null。
 */
export function normalizeEnumValue(slot: SlotDef, value: string): string | null {
  if (!slot.enumValues?.length) return value.trim()
  const hit = slot.enumValues.find(candidate => semanticValuesMatch(candidate, value, { slot }))
  if (hit) return hit
  // 尝试同义规范值（学士 → 本科）
  const canonical = canonicalValue(value)
  const canonicalHit = slot.enumValues.find(candidate => canonicalValue(candidate) === canonical)
  return canonicalHit || null
}
