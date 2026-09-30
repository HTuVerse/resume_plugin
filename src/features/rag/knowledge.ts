import type { Fact, FormField, LearnedAlias } from '../../domain/types'
import type { SectionId } from '../../domain/slots'
import { factToSlot } from '../autofill/match/factToSlot'
import { SLOTS, aliasHit, aliasSectionCount, slotByAliasInSection, slotById } from '../ontology/slotRegistry'
import { sectionLabel, sectionOfText } from '../ontology/sections'
import { isFieldIdentifier } from '../autofill/scan/labelResolver'
import { normalize } from '../../shared/normalize'

/**
 * 本地知识库（RAG）统一入口。
 *
 * 知识库的本体就是「我的信息」（profile facts），本模块统一三件事：
 * 1. 归类（canonicalize）：任意来源的键值 → (板块, 条目, 规范字段名)，
 *    槽位命中即归一到规范名；未命中保持原样（自定义字段）。
 * 2. 学习（classifyPageInput）：捕捉网页手动输入 → 候选 Fact，
 *    必须经用户在面板中确认后才入库（不静默采集）。
 * 3. 合并（mergeIntoKnowledge）：能映射到槽位时按 (板块, 条目, 槽位) 更新，
 *    字段名写成规范名；否则按原字段名新增。绝不删除既有信息。
 *
 * 简历提取、Excel 导入、网页学习三条通道全部经过本模块，分类规则只有一份。
 */

export interface KnowledgeMergeResult {
  facts: Fact[]
  added: number
  updated: number
}

/** 任意分组文本 → 规范板块名（「教育背景」→「教育经历」）；无法识别时原样返回。 */
export function canonicalGroupName(text: string): string {
  const trimmed = String(text || '').trim()
  if (!trimmed) return '其他'
  const section = sectionOfText(trimmed)
  return section ? sectionLabel(section) : trimmed
}

/** 槽位命中时把 Fact 的分组 / 字段名归一为规范名；未命中只归一分组（自定义字段保留原键名）。 */
export function canonicalizeFact(fact: Fact): Fact {
  const { slot, section } = factToSlot(fact)
  const def = slot ? slotById(slot) : undefined
  if (def) return { ...fact, group: sectionLabel(def.section), key: def.aliases[0] }
  if (section) return { ...fact, group: sectionLabel(section) }
  return fact
}

/** 批量归一并按 (板块, 条目, 字段, 值) 去重（不同值保留，供用户核对）。 */
export function canonicalizeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>()
  const out: Fact[] = []
  for (const fact of facts.map(canonicalizeFact)) {
    const identity = `${normalize(fact.group)}|${Math.max(1, fact.item || 1)}|${normalize(fact.key)}|${normalize(fact.value)}`
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push(fact)
  }
  return out
}

/** 网页学习候选：一条待用户确认的知识库条目。 */
export interface LearnedEntry {
  fact: Fact
  /** 命中的槽位；无则为自定义字段。 */
  slot?: string
  custom: boolean
  fieldLabel: string
}

const MAX_LEARNED_VALUE_LENGTH = 5000
const MAX_CUSTOM_LABEL_LENGTH = 40
const REPEAT_SECTIONS = new Set(['education', 'work', 'internship', 'project', 'campus', 'award', 'certificate', 'family'])

/**
 * 标签与内置别名或已学别名全等时落到槽位。
 * 页面已经认出板块时只在该板块里找，避免把家庭成员的姓名写进基本信息。
 */
function exactSlotForLabel(label: string, section: SectionId | '', learned: LearnedAlias[] = []): string | undefined {
  const key = normalize(label)
  if (!key) return undefined
  const rows = learned.filter(item => !item.disabled && normalize(item.alias) === key && slotById(item.slot))
  if (section) {
    const scoped = rows.find(item => item.sectionId === section)
    if (scoped && slotById(scoped.slot)?.section === section) return scoped.slot
    const global = rows.find(item => !item.sectionId)
    const globalSlot = global ? slotById(global.slot) : undefined
    if (globalSlot && globalSlot.section === section && aliasSectionCount(label) < 2) return globalSlot.id
    return slotByAliasInSection(section, label)?.id
  }
  const globals = rows.filter(item => !item.sectionId)
  const learnedSlots = new Set(globals.map(item => item.slot))
  if (learnedSlots.size === 1 && aliasSectionCount(label) < 2) return globals[0].slot
  const hits = SLOTS.filter(slot => aliasHit(slot, label))
  return hits.length === 1 ? hits[0].id : undefined
}

/**
 * 把用户在网页字段上手动输入的值归类为知识库候选（用户需求 3）。
 * 槽位已识别，或标签与别名全等 → 按槽位规范名归类；仍未识别 → 按字段标签保存为该板块的自定义字段。
 * 返回 null 表示该输入不适合入库（空值、超长、无可用标签）。
 */
export function classifyPageInput(field: FormField, value: string, learnedAliases: LearnedAlias[] = []): LearnedEntry | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_LEARNED_VALUE_LENGTH) return null
  const now = new Date().toISOString()
  const pageSection = (field.sectionId || sectionOfText(field.group)) as SectionId | ''
  const detected = field.slot ? slotById(field.slot) : undefined
  let def = detected && pageSection && detected.section !== pageSection
    ? slotByAliasInSection(pageSection, field.label)
    : detected
  if (!def || (pageSection && def.section !== pageSection)) {
    const id = exactSlotForLabel(field.label, pageSection, learnedAliases)
    const found = id ? slotById(id) : undefined
    def = found && (!pageSection || found.section === pageSection) ? found : undefined
  }
  if (def && (!pageSection || def.section === pageSection)) {
    return {
      slot: def.id,
      custom: false,
      fieldLabel: field.label,
      fact: {
        id: crypto.randomUUID(),
        group: sectionLabel(def.section),
        item: def.repeatable ? Math.max(1, field.item || 1) : 1,
        key: def.aliases[0],
        value: trimmed,
        evidence: `网页学习：${field.label || def.aliases[0]}`,
        source: 'profile',
        updatedAt: now
      }
    }
  }
  const label = field.label.trim()
  if (!label || label.length > MAX_CUSTOM_LABEL_LENGTH || isFieldIdentifier(label)) return null
  return {
    custom: true,
    fieldLabel: label,
    fact: {
      id: crypto.randomUUID(),
      group: pageSection ? sectionLabel(pageSection) : '其他',
      item: REPEAT_SECTIONS.has(pageSection) ? Math.max(1, field.item || 1) : 1,
      key: label,
      value: trimmed,
      evidence: `网页学习：${label}`,
      source: 'profile',
      updatedAt: now
    }
  }
}

/**
 * 合并身份：能映射到槽位时用 (板块, 条目, 槽位)，因此「名字」和「姓名」是同一条。
 * 自定义字段仍用规范化字段名。能识别的板块用板块 ID，「奖励荣誉」和「在校获奖荣誉」不会各存一份。
 */
export function knowledgeIdentity(fact: Pick<Fact, 'group' | 'item' | 'key'>): string {
  const section = sectionOfText(fact.group)
  const groupKey = section || normalize(fact.group)
  const mapped = factToSlot(fact)
  const fieldKey = mapped.slot || normalize(fact.key)
  return `${groupKey}\u0000${Math.max(1, Number(fact.item) || 1)}\u0000${fieldKey}`
}

function identityOf(fact: Pick<Fact, 'group' | 'item' | 'key'>): string {
  return knowledgeIdentity(fact)
}

/**
 * 合并进知识库：同一槽位或同一自定义字段更新值并保留原 id，否则新增。
 * 不会删除未出现在 incoming 中的既有信息。能映射的字段名写成规范名。
 */
export function mergeIntoKnowledge(existing: Fact[], incoming: Fact[]): KnowledgeMergeResult {
  const order: string[] = []
  const byIdentity = new Map<string, Fact>()
  for (const fact of existing) {
    const identity = identityOf(fact)
    const mapped = factToSlot(fact)
    const canonicalKey = mapped.slot ? slotById(mapped.slot)?.aliases[0] : undefined
    const normalized = canonicalKey ? { ...fact, key: canonicalKey } : fact
    const current = byIdentity.get(identity)
    if (!current) {
      order.push(identity)
      byIdentity.set(identity, normalized)
      continue
    }
    const currentStamp = Date.parse(current.updatedAt || '') || 0
    const nextStamp = Date.parse(normalized.updatedAt || '') || 0
    const nextWins = (Boolean(normalized.value.trim()) && !current.value.trim()) || (nextStamp >= currentStamp && Boolean(normalized.value.trim()))
    if (nextWins) byIdentity.set(identity, { ...normalized, id: current.id, group: current.group })
  }
  let added = 0
  let updated = 0
  for (const fact of incoming) {
    const identity = identityOf(fact)
    const current = byIdentity.get(identity)
    if (current) updated += 1
    else {
      added += 1
      order.push(identity)
    }
    const mapped = factToSlot(fact)
    const canonicalKey = mapped.slot ? slotById(mapped.slot)?.aliases[0] : undefined
    byIdentity.set(identity, {
      ...fact,
      id: current?.id || fact.id || crypto.randomUUID(),
      // 更新时保留原分组名，已存的「奖励荣誉」不会被改写成新规范名。
      group: current?.group || fact.group,
      key: canonicalKey || fact.key,
      source: 'profile',
      updatedAt: new Date().toISOString()
    })
  }
  return { facts: order.map(identity => byIdentity.get(identity)!), added, updated }
}

/**
 * 把别名键折回规范名，并合并同一槽位的重复行。
 * 值不同时保留更新时间较新的一条；空值不覆盖已有内容。
 */
export function foldProfileFacts(facts: Fact[]): Fact[] {
  const order: string[] = []
  const byIdentity = new Map<string, Fact>()
  for (const raw of facts) {
    const folded = canonicalizeFact(raw)
    const identity = knowledgeIdentity(folded)
    const current = byIdentity.get(identity)
    if (!current) {
      order.push(identity)
      byIdentity.set(identity, folded)
      continue
    }
    const currentStamp = Date.parse(current.updatedAt || '') || 0
    const nextStamp = Date.parse(folded.updatedAt || '') || 0
    const nextWins = (Boolean(folded.value.trim()) && !current.value.trim()) || (nextStamp >= currentStamp && Boolean(folded.value.trim()))
    if (!nextWins) continue
    byIdentity.set(identity, { ...folded, id: current.id, group: current.group })
  }
  return order.map(identity => byIdentity.get(identity)!)
}
