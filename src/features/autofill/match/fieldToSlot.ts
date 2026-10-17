import type { SlotDecision, SlotDef, SlotScore } from '../../../domain/slots'
import type { FormField, SiteRule } from '../../../domain/types'
import { normalize } from '../../../shared/normalize'
import type { LearnedAlias } from '../../ontology/learnedAliases'
import { isPlaceholderOption } from '../../ontology/optionMatch'
import { SLOTS, aliasHit, aliasSectionCount, legacyAliasHit, slotById } from '../../ontology/slotRegistry'
import { findSiteRule } from '../../siteRules/ruleStore'
import { sameValue } from '../../ontology/synonyms'
import { subjectSectionOf } from './subjectScope'

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

  const exactLabel = Boolean(label) && (aliasHit(slot, label) || (field.sectionId === slot.section && legacyAliasHit(slot, label)))
  const weakLabel = field.labelSource === 'sibling' || field.labelSource === 'placeholder'
  // 别名全等时不再因为标签来自兄弟节点或占位符而降权。降权只作用于正则这种非全等命中。
  const labelFactor = weakLabel && !exactLabel ? WEAK_LABEL_FACTOR : 1

  const values: Record<string, number | null> = {
    labelMatch: label
      ? (exactLabel ? labelFactor : patternHit(slot, label) ? 0.75 * labelFactor : 0)
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
function findLearned(field: FormField, aliases: LearnedAlias[] | undefined): LearnedAlias | undefined {
  const labelKey = normalize(field.label)
  if (!labelKey || !aliases?.length) return undefined
  const exact = aliases.filter(item => !item.disabled && normalize(item.alias) === labelKey && slotById(item.slot))
  const scoped = field.sectionId ? exact.find(item => item.sectionId === field.sectionId) : undefined
  if (scoped) return scoped
  const global = exact.find(item => !item.sectionId)
  if (global) return global
  if (!field.sectionId || labelKey.length > 20) return undefined
  const loose = aliases.filter(item => {
    if (item.disabled || item.sectionId !== field.sectionId) return false
    const alias = normalize(item.alias)
    if (alias.length < 4 || alias.length > 12 || alias === labelKey) return false
    const slot = slotById(item.slot)
    if (!slot || slot.section !== field.sectionId) return false
    if (slot.excludePatterns?.some(pattern => pattern.test(field.label))) return false
    const short = alias.length <= labelKey.length ? alias : labelKey
    const long = short === alias ? labelKey : alias
    return long.includes(short) && long.length - short.length <= 4
  })
  const slots = new Set(loose.map(item => item.slot))
  return slots.size === 1 ? loose[0] : undefined
}

export function scoreFieldSlots(field: FormField, context: ScoreContext = {}): SlotScore[] {
  const subjectSection = subjectSectionOf(field)
  // 站点规则短路（F25）：指纹优先，其次是用户确认过的同类标签。
  const rule = findSiteRule(context.siteRules, field)
  if (rule && (!subjectSection || slotById(rule.slot)?.section === subjectSection)) {
    return [{ slot: rule.slot, score: 1, locked: true, signals: { siteRule: 1 } }]
  }
  // 学到的别名：全等锁定。带板块的别名只在该板块生效。
  // 同一板块里，短别名可以盖住多出来的几个字（毕业院校 → 毕业院校名称）。
  const learned = findLearned(field, context.learnedAliases)
  const learnedSlot = learned ? slotById(learned.slot) : undefined
  const learnedApplies = Boolean(
    learned && learnedSlot
    && (!subjectSection || learnedSlot.section === subjectSection)
    && (learned.sectionId
      ? subjectSection === learned.sectionId
      : (!subjectSection || learnedSlot.section === subjectSection)
        && (subjectSection || aliasSectionCount(field.label) < 2))
  )
  if (learnedApplies && learned) {
    return [{ slot: learned.slot, score: 1, locked: true, signals: { learnedAlias: 1 } }]
  }
  const scored: SlotScore[] = []
  for (const slot of SLOTS) {
    if (subjectSection && slot.section !== subjectSection) continue
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

function inSection(candidate: SlotScore, sectionId: string | undefined): boolean {
  if (!sectionId) return true
  return slotById(candidate.slot)?.section === sectionId
}

function clearMargin(top: SlotScore, scores: SlotScore[]): boolean {
  const second = scores.find(candidate => candidate.slot !== top.slot)
  return !second || top.score - second.score >= MARGIN
}

/**
 * 板块内（或全局唯一）的正则命中。要求 labelMatch ≥ 0.75 且总分 ≥ T_HIGH，
 * 并与第二名拉开 MARGIN。兄弟节点上的非全等标签已被降权，到不了这条线。
 */
function patternDecision(scores: SlotScore[], sectionId?: string): SlotScore | undefined {
  const hits = scores.filter(candidate => (candidate.signals.labelMatch || 0) >= 0.75 && candidate.score >= T_HIGH && inSection(candidate, sectionId))
  if (hits.length !== 1) return undefined
  return clearMargin(hits[0], scores) ? hits[0] : undefined
}

/**
 * name / autocomplete 唯一命中，且没有别的槽位抢同一个属性。
 * 页面已经认出板块时，槽位必须落在这个板块里。
 */
function attrDecision(scores: SlotScore[], sectionId?: string): SlotScore | undefined {
  const hits = scores.filter(candidate => candidate.signals.attrAlias === 1 && inSection(candidate, sectionId))
  const slots = new Set(hits.map(candidate => candidate.slot))
  if (slots.size !== 1) return undefined
  const exact = scores.find(candidate => candidate.signals.labelMatch === 1)
  if (exact && exact.slot !== hits[0].slot) return undefined
  return hits[0]
}

/**
 * 选项集合能唯一反推槽位。
 * 有板块时只在该板块里认；没有板块时，全局只对上一个槽位，并且和第二名拉开差距，才解析。
 * 同一套选项对上两个槽位（最高学历和学历）时不猜。
 */
function enumDecision(scores: SlotScore[], sectionId?: string): SlotScore | undefined {
  const hits = scores.filter(candidate => (candidate.signals.enumSignature || 0) >= 0.67 && inSection(candidate, sectionId))
  if (hits.length !== 1) return undefined
  const chosen = hits[0]
  if (sectionId) {
    const top = scores[0]
    if (top && top.slot !== chosen.slot && top.score > chosen.score) return undefined
    return chosen
  }
  return clearMargin(chosen, scores) ? chosen : undefined
}

/**
 * 决策顺序：
 * 1. 站点规则、学到的别名（锁定）；
 * 2. 标签与槽位别名全等，且落在已识别板块内；同名多板块且板块未知则不猜；
 * 3. 高置信正则（毕业院校名称）、唯一的 name/autocomplete，或唯一的选项签名（男/女）。
 * 乱码标签、多个槽位共用的 name、对不上板块的唯一别名，仍然留空。
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
    const inExactSection = exactAll.filter(candidate => slotById(candidate.slot)?.section === sectionId)
    if (inExactSection.length === 1) return { status: 'resolved', slot: inExactSection[0].slot, candidates }
    if (exactAll.length) return { status: inExactSection.length > 1 ? 'ambiguous' : 'unknown', candidates }
  }
  const exact = candidates.filter(candidate => candidate.signals.labelMatch === 1)
  if (exact.length === 1) return { status: 'resolved', slot: exact[0].slot, candidates }
  // 同一标签精确命中多个槽位（如「开始时间」同时在项目、实习、校内活动）：
  // 仅当字段所在板块能唯一消解时才自动填，否则不猜
  const exactInSection = exact.filter(candidate => candidate.signals.sectionMatch === 1)
  if (exactInSection.length === 1) return { status: 'resolved', slot: exactInSection[0].slot, candidates }
  if (exact.length > 1) return { status: 'ambiguous', candidates }
  const pattern = patternDecision(scores, sectionId)
  if (pattern) return { status: 'resolved', slot: pattern.slot, candidates }
  const attributed = attrDecision(scores, sectionId)
  if (attributed) return { status: 'resolved', slot: attributed.slot, candidates }
  const enumerated = enumDecision(scores, sectionId)
  if (enumerated) return { status: 'resolved', slot: enumerated.slot, candidates }
  return { status: 'unknown', candidates }
}
