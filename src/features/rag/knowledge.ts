import type { Fact, FormField } from '../../domain/types'
import type { SectionId } from '../../domain/slots'
import { factToSlot } from '../autofill/match/factToSlot'
import { slotById, slotByAliasInSection } from '../ontology/slotRegistry'
import { sectionLabel, sectionOfText } from '../ontology/sections'
import { normalize } from '../../shared/normalize'

/**
 * 本地知识库（RAG）统一入口。
 *
 * 知识库的本体就是「我的信息」（profile facts），本模块统一三件事：
 * 1. 归类（canonicalize）：任意来源的键值 → (板块, 条目, 规范字段名)，
 *    槽位命中即归一到规范名；未命中保持原样（自定义字段）。
 * 2. 学习（classifyPageInput）：捕捉网页手动输入 → 候选 Fact，
 *    必须经用户在面板中确认后才入库（不静默采集）。
 * 3. 合并（mergeIntoKnowledge）：同 (板块, 条目, 字段) 更新值，否则新增，
 *    绝不删除既有信息。
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

/**
 * 把用户在网页字段上手动输入的值归类为知识库候选（用户需求 3）。
 * 槽位已识别 → 按槽位规范名归类；未识别 → 按字段标签保存为该板块的自定义字段。
 * 返回 null 表示该输入不适合入库（空值、超长、无可用标签）。
 */
export function classifyPageInput(field: FormField, value: string): LearnedEntry | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_LEARNED_VALUE_LENGTH) return null
  const now = new Date().toISOString()
  const pageSection = (field.sectionId || sectionOfText(field.group)) as SectionId | ''
  const detected = field.slot ? slotById(field.slot) : undefined
  const def = detected && pageSection && detected.section !== pageSection
    ? slotByAliasInSection(pageSection, field.label)
    : detected
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
  if (!label || label.length > MAX_CUSTOM_LABEL_LENGTH) return null
  return {
    custom: true,
    fieldLabel: label,
    fact: {
      id: crypto.randomUUID(),
      group: pageSection ? sectionLabel(pageSection) : '其他',
      item: Math.max(1, field.item || 1),
      key: label,
      value: trimmed,
      evidence: `网页学习：${label}`,
      source: 'profile',
      updatedAt: now
    }
  }
}

/**
 * 合并身份：(板块, 条目, 字段)。
 * 能识别的板块用板块 ID，因此「奖励荣誉」和「在校获奖荣誉」是同一段，不会各存一份。
 */
export function knowledgeIdentity(fact: Pick<Fact, 'group' | 'item' | 'key'>): string {
  const section = sectionOfText(fact.group)
  const groupKey = section || normalize(fact.group)
  return `${groupKey}\u0000${Math.max(1, Number(fact.item) || 1)}\u0000${normalize(fact.key)}`
}

function identityOf(fact: Pick<Fact, 'group' | 'item' | 'key'>): string {
  return knowledgeIdentity(fact)
}

/**
 * 合并进知识库：同 (板块, 条目, 字段) 更新值并保留原 id，否则新增；
 * 不会删除未出现在 incoming 中的既有信息。
 */
export function mergeIntoKnowledge(existing: Fact[], incoming: Fact[]): KnowledgeMergeResult {
  const order: string[] = []
  const byIdentity = new Map<string, Fact>()
  for (const fact of existing) {
    const identity = identityOf(fact)
    if (!byIdentity.has(identity)) order.push(identity)
    byIdentity.set(identity, fact)
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
    byIdentity.set(identity, {
      ...fact,
      id: current?.id || fact.id || crypto.randomUUID(),
      // 更新时保留原分组名，已存的「奖励荣誉」不会被改写成新规范名。
      group: current?.group || fact.group,
      source: 'profile',
      updatedAt: new Date().toISOString()
    })
  }
  return { facts: order.map(identity => byIdentity.get(identity)!), added, updated }
}
