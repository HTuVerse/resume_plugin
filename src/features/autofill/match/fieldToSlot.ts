import type { SlotDecision, SlotDef, SlotScore } from '../../../domain/slots'
import type { FormField, SiteRule } from '../../../domain/types'
import { normalize } from '../../../shared/normalize'
import type { LearnedAlias } from '../../ontology/learnedAliases'
import { isPlaceholderOption } from '../../ontology/optionMatch'
import { SLOTS, aliasHit, legacyAliasHit, slotById } from '../../ontology/slotRegistry'
import { sameValue } from '../../ontology/synonyms'

/**
 * 页面字段 → 槽位的多信号加权打分与决策（F02/F03，TECH_DESIGN §5）。
 *
 * 关键设计：
 * - 取消旧 mapField 的「词典未命中即退化为字符串全等」分支（R1）。
 * - 每个信号输出 [0,1]，加权求和后按「有数据的信号的权重和」归一。
 *   信号为 null 表示字段侧数据缺失（如无选项集），不计入分母；
 *   数据存在但不匹配时为 0，计入分母以稀释弱信号。
 * - excludePatterns 命中即该槽位得分归零（消歧主力，§5.3）。
 */

export const T_HIGH = 0.72
export const T_LOW = 0.35
export const MARGIN = 0.12

interface SignalDef {
  id: string
  weight: number
}

const SIGNALS: SignalDef[] = [
  // 标签匹配为单一信号：全等 = 1，正则 = 0.75（拆成两个信号会互相稀释）
  { id: 'labelMatch', weight: 1.0 },
  { id: 'attrAlias', weight: 0.7 },
  { id: 'enumSignature', weight: 0.85 },
  { id: 'sectionMatch', weight: 0.35 },
  { id: 'typeMatch', weight: 0.25 },
  { id: 'constraintMatch', weight: 0.2 },
  { id: 'placeholderHit', weight: 0.3 },
  { id: 'nearbyText', weight: 0.15 }
]

/** 标签来源为 sibling/placeholder 时对标签类信号打折。 */
const WEAK_LABEL_FACTOR = 0.7

function patternHit(slot: SlotDef, text: string): boolean {
  return Boolean(text) && Boolean(slot.patterns?.some(pattern => pattern.test(text)))
}

function aliasOrPatternHit(slot: SlotDef, text: string): boolean {
  return aliasHit(slot, text) || patternHit(slot, text)
}

function attrAliasSignal(slot: SlotDef, field: FormField): number | null {
  const attrs = field.attrs
  const values = [attrs?.name, attrs?.id, attrs?.autocomplete].filter((value): value is string => Boolean(value))
  if (!values.length) return null
  if (!slot.attrAliases?.length) return 0
  for (const raw of values) {
    const value = normalize(raw)
    for (const alias of slot.attrAliases) {
      const aliasNorm = normalize(alias)
      // 短别名（<5 字符）只允许全等，避免 name ⊂ username 之类误命中
      if (value === aliasNorm) return 1
      if (aliasNorm.length >= 5 && value.includes(aliasNorm)) return 1
    }
  }
  return 0
}

/** 选项集合反推槽位（F03）：|O∩E| / min(|O|,|E|)，且交集 ≥2 才有效。 */
function enumSignatureSignal(slot: SlotDef, field: FormField): number | null {
  if (!field.options.length) return null
  if (!slot.enumValues?.length) return 0
  const pageOptions = field.options.filter(option => option.trim() && !isPlaceholderOption(option))
  if (pageOptions.length < 2) return 0
  let intersection = 0
  for (const standard of slot.enumValues) {
    if (pageOptions.some(option => sameValue(option, standard))) intersection += 1
  }
  if (intersection < 2) return 0
  return intersection / Math.min(pageOptions.length, slot.enumValues.length)
}

function sectionSignal(slot: SlotDef, field: FormField): number | null {
  if (!field.sectionId) return null
  return field.sectionId === slot.section ? 1 : 0
}

function typeSignal(slot: SlotDef, field: FormField): number {
  const kind = field.kind
  switch (slot.valueType) {
    case 'date':
    case 'month':
      return kind === 'date' ? 1 : (kind === 'text' || kind === 'select' || kind === 'combobox' ? 0.5 : 0)
    case 'enum':
    case 'boolean':
      return ['select', 'radio', 'combobox', 'checkbox', 'multiselect'].includes(kind) ? 1 : (kind === 'text' ? 0.4 : 0)
    case 'longtext':
      return kind === 'textarea' ? 1 : (kind === 'text' ? 0.4 : 0)
    case 'phone':
    case 'email':
    case 'number':
    case 'url':
      return kind === 'text' ? 1 : 0
    case 'text':
    default:
      return ['text', 'combobox', 'select'].includes(kind) ? 0.8 : 0.4
  }
}

/** maxLength / input[type] / inputmode 与 valueType 的相容性。 */
function constraintSignal(slot: SlotDef, field: FormField): number | null {
  const type = field.attrs?.type?.toLowerCase()
  const inputmode = field.attrs?.inputmode?.toLowerCase()
  const hasConstraint = Boolean(type && !['text', 'search'].includes(type)) || Boolean(inputmode) || field.maxLength > 0
  if (!hasConstraint) return null
  let score = 0
  if (slot.valueType === 'phone') {
    if (type === 'tel' || inputmode === 'tel') score = Math.max(score, 1)
    if (field.maxLength === 11) score = Math.max(score, 0.8)
    if (inputmode === 'numeric') score = Math.max(score, 0.5)
  }
  if (slot.valueType === 'email' && type === 'email') score = 1
  if ((slot.valueType === 'date' || slot.valueType === 'month') && (type === 'date' || type === 'month')) score = 1
  if (slot.valueType === 'number' && (type === 'number' || inputmode === 'numeric' || inputmode === 'decimal')) score = 1
  if (slot.valueType === 'url' && type === 'url') score = 1
  if (slot.maxLengthHint && field.maxLength > 0 && field.maxLength === slot.maxLengthHint) score = Math.max(score, 0.6)
  return score
}

interface CollectedSignals {
  excluded: boolean
  values: Record<string, number | null>
}

function collectSignals(field: FormField, slot: SlotDef): CollectedSignals {
  const label = field.label.trim()
  const placeholder = field.placeholder.trim()
  const nearby = field.nearbyText?.trim() || ''
  const context = `${label} ${placeholder} ${nearby}`

  if (slot.excludePatterns?.some(pattern => pattern.test(context))) {
    return { excluded: true, values: {} }
  }

  const weakLabel = field.labelSource === 'sibling' || field.labelSource === 'placeholder'
  const labelFactor = weakLabel ? WEAK_LABEL_FACTOR : 1

  const values: Record<string, number | null> = {
    labelMatch: label
      ? ((aliasHit(slot, label) || (field.sectionId === slot.section && legacyAliasHit(slot, label))) ? labelFactor : patternHit(slot, label) ? 0.75 * labelFactor : 0)
      : null,
    attrAlias: attrAliasSignal(slot, field),
    enumSignature: enumSignatureSignal(slot, field),
    sectionMatch: sectionSignal(slot, field),
    typeMatch: typeSignal(slot, field),
    constraintMatch: constraintSignal(slot, field),
    placeholderHit: placeholder ? (aliasOrPatternHit(slot, placeholder) ? 1 : 0) : null,
    nearbyText: nearby ? (aliasOrPatternHit(slot, nearby) ? 1 : 0) : null
  }
  return { excluded: false, values }
}

export interface ScoreContext {
  siteRules?: SiteRule[]
  /** 学到的字段别名（姓名 ↔ 名字），命中即锁定槽位。 */
  learnedAliases?: LearnedAlias[]
}

/** 对单个字段给出全部槽位的打分（降序）。 */
export function scoreFieldSlots(field: FormField, context: ScoreContext = {}): SlotScore[] {
  // 站点规则短路（F25）：命中且未被降权则直接锁定槽位
  const rule = context.siteRules?.find(item => !item.disabled && item.fieldFingerprint === field.fingerprint)
  if (rule) {
    return [{ slot: rule.slot, score: 1, locked: true, signals: { siteRule: 1 } }]
  }
  // 学到的别名：字段标签与已学习措辞全等即锁定（跨站点生效）。
  // 页面板块已经认出来时，别名槽位必须属于这一板块，不能把「开始时间」从项目锁到实习。
  const learned = context.learnedAliases?.find(item => item.alias === field.label.trim() && slotById(item.slot))
  const learnedSlot = learned ? slotById(learned.slot) : undefined
  if (learned && learnedSlot && (!field.sectionId || learnedSlot.section === field.sectionId)) {
    return [{ slot: learned.slot, score: 1, locked: true, signals: { learnedAlias: 1 } }]
  }
  const scored: SlotScore[] = []
  for (const slot of SLOTS) {
    const { excluded, values } = collectSignals(field, slot)
    if (excluded) continue
    let sum = 0
    let norm = 0
    const signals: Record<string, number> = {}
    for (const signal of SIGNALS) {
      const value = values[signal.id]
      if (value === null || value === undefined) continue
      sum += signal.weight * value
      norm += signal.weight
      if (value > 0) signals[signal.id] = Number(value.toFixed(3))
    }
    const score = norm ? sum / norm : 0
    if (score > 0) scored.push({ slot: slot.id, score: Number(score.toFixed(4)), signals })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/**
 * 决策：只有「字段名精确命中」才自动填写，其余一律留空（用户要求精确匹配）。
 *
 * 精确来源有三种，都会把得分锁定为 1：
 * - 字段标签与槽位别名规范化全等（labelMatch = 1，如 姓名 / 名字 / 手机号）；
 * - 学到的别名（learnedAlias，用户在面板中手动确认后记住的措辞）；
 * - 该站点已学习的规则（siteRule）。
 * 页面板块已经认出来时，精确命中必须落在这个板块里。
 * 唯一命中但属于别的板块时不采用，避免同名字段串板块。
 * 区块未知时，弱信号仍不参与自动判定。
 */
export function decideSlot(scores: SlotScore[], sectionId?: string): SlotDecision {
  const candidates = scores.slice(0, 5)
  const top1 = candidates[0]
  if (!top1) return { status: 'unknown', candidates: [] }
  if (top1.locked) {
    const lockedSection = slotById(top1.slot)?.section
    const learnedAcrossSections = Boolean(top1.signals.learnedAlias && sectionId && lockedSection && lockedSection !== sectionId)
    if (!learnedAcrossSections) return { status: 'resolved', slot: top1.slot, candidates }
  }
  const exactAll = scores.filter(candidate => candidate.signals.labelMatch === 1)
  if (sectionId) {
    const inSection = exactAll.filter(candidate => slotById(candidate.slot)?.section === sectionId)
    if (inSection.length === 1) return { status: 'resolved', slot: inSection[0].slot, candidates }
    if (exactAll.length) return { status: inSection.length > 1 ? 'ambiguous' : 'unknown', candidates }
  }
  const exact = candidates.filter(candidate => candidate.signals.labelMatch === 1)
  if (exact.length === 1) return { status: 'resolved', slot: exact[0].slot, candidates }
  // 同一标签精确命中多个槽位（如「开始时间」同时在项目、实习、校内活动）：
  // 仅当字段所在板块能唯一消解时才自动填，否则不猜
  const inSection = exact.filter(candidate => candidate.signals.sectionMatch === 1)
  if (inSection.length === 1) return { status: 'resolved', slot: inSection[0].slot, candidates }
  if (exact.length > 1) return { status: 'ambiguous', candidates }
  return { status: 'unknown', candidates }
}
