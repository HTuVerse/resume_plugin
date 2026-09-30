import type { Fact, FieldCandidate, FormField, ResolvedField, SlotSuggestion } from '../../domain/types'
import { normalize } from '../../shared/normalize'
import { slotById } from '../ontology/slotRegistry'
import { sectionOfText } from '../ontology/sections'
import { factToSlot, indexFactsBySlot } from './match/factToSlot'
import { gateValue } from './match/join'
import { mergeFactsByPriority } from './factPriority'

/**
 * 槽位连接 + 校验闸门（重写版，TECH_DESIGN §15）。
 *
 * 页面字段已在扫描阶段带上槽位判定（field.slot / slotStatus），
 * 本层负责：(slot, section, item) 三元组连接档案 Fact → 闸门校验 →
 * ready / needs-confirmation / empty 三态输出（F07）。
 */

export interface FactIndex {
  merged: Fact[]
  bySlot: Map<string, Fact[]>
  /** 未命中任何槽位的自定义字段（Excel / 网页学习产生），按规范化键名索引。 */
  byCustomKey: Map<string, Fact[]>
}

export function buildFactIndex(profileFacts: Fact[], resumeFacts: Fact[] = []): FactIndex {
  // 知识库（我的信息）是唯一数据源；resumeFacts 仅保留参数兼容，不再参与填充
  const merged = mergeFactsByPriority(profileFacts, resumeFacts)
  const byCustomKey = new Map<string, Fact[]>()
  for (const fact of merged) {
    if (!fact.value.trim() || factToSlot(fact).slot) continue
    const key = normalize(fact.key)
    if (!key) continue
    const list = byCustomKey.get(key) || []
    list.push(fact)
    byCustomKey.set(key, list)
  }
  return { merged, bySlot: indexFactsBySlot(merged), byCustomKey }
}

export interface ResolveOptions {
  /** 用户显式开启自动填写的敏感槽位 ID 集合（F54）。 */
  enabledSensitiveSlots?: Set<string>
  /** AI 仲裁建议，仍需过闸门；低置信结果会先预填并标记为待确认。 */
  aiSuggestion?: SlotSuggestion
  /** AI 自动填写匹配阈值（0–100）。达到且闸门通过 → ready，否则待确认。默认 85。 */
  aiMatchThreshold?: number
  /**
   * 家庭关系按称谓对齐后的知识库条目。
   * null：页面已写明称谓，但知识库没有这个人，留空以免串段。
   */
  segmentItem?: number | null
  /**
   * 页面上没有实习板块时，工作经历可以沿用仍存在「实习经历」分组里的旧档案。
   * 同一页既有工作又有实习时不要开，避免两段填成同一份。
   */
  legacyWorkFallback?: boolean
}

/**
 * 可先写入网页、但仍需用户在核对界面确认的结果。
 * 目前只包含已通过值域/控件闸门、仅因 AI 置信度低于阈值而待确认的结果。
 */
export function isPreviewFillable(resolved: ResolvedField | undefined): boolean {
  return resolved?.status === 'ready'
    || (resolved?.status === 'needs-confirmation'
      && resolved.reasonCode === 'ai-suggested'
      && Boolean(resolved.value.trim()))
}

function candidateOf(field: FormField, fact: Fact, reason: string): FieldCandidate {
  return {
    fieldId: field.id,
    factId: fact.id,
    value: fact.value,
    source: fact.source === 'profile' ? 'profile' : 'resume',
    confidence: fact.source === 'profile' ? 0.95 : 0.9,
    reason,
    evidence: fact.evidence
  }
}

function empty(field: FormField, reason: string, reasonCode: ResolvedField['reasonCode'], candidates: FieldCandidate[] = []): ResolvedField {
  return { fieldId: field.id, value: '', source: 'empty', confidence: 0, reason, candidates, status: 'empty', reasonCode, slot: field.slot }
}

function pickFactsForItem(field: FormField, facts: Fact[], segmentItem?: number | null): Fact[] {
  const repeatable = field.slot ? slotById(field.slot)?.repeatable : false
  if (repeatable && segmentItem === null) return []
  const item = segmentItem || field.item
  if (repeatable && item) {
    const sameItem = facts.filter(fact => Math.max(1, fact.item || 1) === item)
    // 页面是重复段但档案只有一段时，第 1 段可以用 item=1 的数据；其他段留空防串段
    if (sameItem.length) return sameItem
    return []
  }
  // 非重复字段：优先 item=1 的数据
  const first = facts.filter(fact => Math.max(1, fact.item || 1) === 1)
  return first.length ? first : facts
}

function candidatesOfCited(field: FormField, fact: Fact): FieldCandidate[] {
  return [candidateOf(field, fact, 'AI 按字段含义匹配知识库')]
}

/**
 * 用指定的知识库条目生成解析结果（本地精确命中与 AI 指定条目共用）。
 * adapted 为 AI 按表单粒度截取的值（如 江西吉安永丰 → 江西吉安），
 * 调用前已验证它是原值的连续子串；闸门必须校验最终写入值，不能只校验原值。
 */
function gatedResolution(field: FormField, fact: Fact, slot: string | undefined, adapted: string | undefined, candidates: FieldCandidate[], viaAi: boolean, aiConfidence = 0.6, aiMatchThreshold = 85): ResolvedField {
  const slotDef = slot ? slotById(slot) : undefined
  const adaptedValue = adapted && fact.value.includes(adapted) ? adapted : undefined
  const valueToWrite = adaptedValue || fact.value
  const gate = gateValue(slotDef, field, valueToWrite)
  if (!gate.ok) {
    return {
      fieldId: field.id, factId: fact.id, value: '', source: 'empty', confidence: 0,
      reason: gate.reason, candidates, status: 'needs-confirmation', reasonCode: gate.reasonCode, slot
    }
  }
  const confidence = viaAi ? Math.min(1, Math.max(0, aiConfidence)) : 0.95
  const adaptedNote = adaptedValue ? `，已按表单要求从「${fact.value}」截取` : ''
  // 高置信且闸门不要求确认才自动填；低于阈值或同义选项转换仍待确认
  const autoFill = !gate.needsConfirmation && (!viaAi || confidence * 100 >= aiMatchThreshold)
  return {
    fieldId: field.id,
    factId: fact.id,
    value: gate.value,
    source: viaAi ? 'ai' : 'profile',
    confidence,
    reason: gate.needsConfirmation
      ? gate.reason
      : viaAi
        ? `AI 匹配知识库「${fact.key}」（置信度 ${Math.round(confidence * 100)}%${autoFill ? '' : `，低于阈值 ${aiMatchThreshold}%`}）${adaptedNote}`
        : `匹配槽位「${slotDef?.aliases[0] || slot}」`,
    candidates,
    status: autoFill ? 'ready' : 'needs-confirmation',
    reasonCode: gate.needsConfirmation ? gate.reasonCode : (viaAi && !autoFill ? 'ai-suggested' : undefined),
    slot
  }
}

/** 自定义字段（无槽位）→ 知识库自定义键名全等即自动填写（与槽位别名全等同一标准）。 */
function resolveCustomField(field: FormField, index: FactIndex, segmentItem?: number | null): ResolvedField | null {
  const labelKey = normalize(field.label)
  if (!labelKey) return null
  const facts = index.byCustomKey.get(labelKey) || []
  if (!facts.length) return null
  if (segmentItem === null) return null
  const targetItem = segmentItem || field.item
  const sameItem = targetItem ? facts.filter(fact => Math.max(1, fact.item || 1) === targetItem) : []
  // 重复段字段不能在同段缺值时退回其它段，否则父亲/母亲、不同经历会互相串写。
  if (targetItem && !sameItem.length) return null
  const matched = targetItem ? sameItem : facts
  const preferred = matched.find(fact => fact.source === 'profile') || matched[0]
  const gate = gateValue(undefined, field, preferred.value)
  if (!gate.ok) return null
  return {
    fieldId: field.id,
    factId: preferred.id,
    value: gate.value,
    source: preferred.source === 'profile' ? 'profile' : 'resume',
    confidence: 0.95,
    reason: `按字段名「${field.label.trim()}」精确匹配到自定义信息`,
    candidates: matched.map(fact => candidateOf(field, fact, '自定义字段名全等匹配')),
    status: 'ready',
    slot: undefined
  }
}

function nameAlignedSection(section: string | undefined): boolean {
  return section === 'family' || section === 'education' || section === 'project' || section === 'work' || section === 'internship'
    || section === 'campus' || section === 'award' || section === 'certificate'
}

/** 二级 AI 只看一级还没精确填上的空字段。已经 ready 的不送进去。 */
export function fieldsNeedingAi<T extends { id: string; current: string }>(fields: T[], statusOf: (id: string) => string | undefined): T[] {
  return fields.filter(field => {
    const status = statusOf(field.id)
    return !field.current.trim() && (!status || status === 'empty')
  })
}

export function resolveField(field: FormField, index: FactIndex, options: ResolveOptions = {}): ResolvedField {
  if (field.kind === 'file') {
    return {
      fieldId: field.id, value: '', source: 'empty', confidence: 0,
      reason: '附件需要你在网页上手动选择，插件不会代为上传',
      candidates: [], status: 'needs-confirmation', reasonCode: 'unsupported-control'
    }
  }
  if (field.current.trim()) {
    return { fieldId: field.id, value: field.current, source: 'empty', confidence: 1, reason: '网页已有内容，默认不覆盖', candidates: [], status: 'skipped', reasonCode: 'skipped-existing', slot: field.slot }
  }

  // 1. 确定槽位：本地精确命中 → AI 建议（仍走闸门）→ 无
  const proposed = options.aiSuggestion?.fieldId === field.id ? options.aiSuggestion : undefined
  const proposedSlot = proposed?.slot && slotById(proposed.slot) ? proposed.slot : undefined
  // 一级本地槽位是确定性结论；二级 AI 只补漏，不能覆盖为别的语义。
  const suggestion = field.slot && proposedSlot && field.slot !== proposedSlot ? undefined : proposed
  let slot = field.slot
  let viaAi = Boolean(suggestion)
  if (!slot && proposedSlot && suggestion) {
    slot = proposedSlot
  }
  const threshold = options.aiMatchThreshold ?? 85
  const segmentItem = options.segmentItem
  const slotDef = slot ? slotById(slot) : undefined
  if (segmentItem === null && nameAlignedSection(slotDef?.section)) {
    const reason = slotDef?.section === 'family'
      ? '这一段的称谓在知识库里没有对应的家庭成员，为避免和父亲、母亲串段已留空'
      : '这一段的名称在知识库里没有对应记录，为避免串段已留空'
    return empty(field, reason, undefined)
  }
  // AI 直接指定了知识库条目（字段名近义，如 名字 ↔ 姓名）：优先使用该条目
  if (suggestion?.factId) {
    const cited = index.merged.find(fact => fact.id === suggestion.factId)
    const citedSlot = cited ? factToSlot(cited).slot : undefined
    const semanticConflict = Boolean(slot && citedSlot && slot !== citedSlot)
    const citedItem = Math.max(1, cited?.item || 1)
    const citedSection = cited ? sectionOfText(cited.group) : ''
    const alignedSection = nameAlignedSection(slotDef?.section || citedSection)
    if (cited && segmentItem === null && alignedSection) {
      return empty(field, '这一段在知识库中没有对应记录，为避免重复段串写已留空', undefined)
    }
    const targetItem = segmentItem || (alignedSection ? field.item : undefined)
    const segmentMismatch = Boolean(cited && targetItem && citedItem !== targetItem)
    if (cited && !semanticConflict && !segmentMismatch) {
      // 只要条目或粒度来自二级 AI，就必须遵守 AI 自动填写阈值。
      return gatedResolution(field, cited, slot, suggestion.adaptedValue, candidatesOfCited(field, cited), true, suggestion.confidence, threshold)
    }
  }
  if (!slot) {
    // 自定义字段回退：只做字段名全等（不做子串），全等即自动填写。
    const custom = resolveCustomField(field, index, segmentItem)
    if (custom) return custom
    if (field.slotStatus === 'ambiguous') {
      return empty(field, '多个槽位得分接近，无法确定字段语义，请手动选择', 'ambiguous-slot')
    }
    return empty(field, '未能识别该字段的语义', 'unknown-slot')
  }

  // 连接档案数据（slot + item）。哪些字段参与填写由用户在「我的信息」中决定，
  // 知识库里没有的字段自然留空，不再维护预设敏感清单。
  let slotFacts = index.bySlot.get(slot) || []
  if (!slotFacts.length && options.legacyWorkFallback && slot.startsWith('work.')) {
    slotFacts = index.bySlot.get(`internship.${slot.slice('work.'.length)}`) || []
  }
  const matched = pickFactsForItem(field, slotFacts, segmentItem)
  if (!matched.length) {
    return empty(field, '档案中没有该槽位的数据', undefined)
  }

  const candidates = matched.map(fact => candidateOf(field, fact, viaAi ? 'AI 判定语义 + 档案数据' : '本地语义匹配'))

  // 4. 多个不同取值 → 待确认，不猜
  const distinctValues = new Set(matched.map(fact => fact.value.trim()))
  const preferred = matched.find(fact => fact.source === 'profile') || matched[0]
  if (distinctValues.size > 1) {
    return {
      fieldId: field.id, factId: preferred.id, value: '', source: 'empty', confidence: 0,
      reason: `存在 ${distinctValues.size} 个不同候选值，请确认`, candidates, status: 'needs-confirmation',
      reasonCode: 'multiple-candidates', slot
    }
  }

  // 5. 校验闸门（AI 结果同样经过）；粒度适配值仅在通过闸门后使用。
  // 本地已精确命中槽位时同样应用适配（如生源地按表单要求截取到市）。
  return gatedResolution(field, preferred, slot, suggestion?.adaptedValue, candidates, viaAi, suggestion?.confidence, threshold)
}
