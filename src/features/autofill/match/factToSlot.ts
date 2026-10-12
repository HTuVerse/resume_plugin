import type { Fact } from '../../../domain/types'
import type { SectionId } from '../../../domain/slots'
import { sectionOfText } from '../../ontology/sections'
import { SLOTS, aliasHit, legacyAliasHit } from '../../ontology/slotRegistry'
import { inferQualifiedField } from '../../ontology/recordIdentity'

/**
 * 档案侧键名 → 槽位（TECH_DESIGN §5 数据侧）。
 * Fact 结构不变（用户已有档案不失效），映射在运行时计算、不写回 Fact。
 */

export interface FactSlot {
  slot?: string
  section: SectionId | ''
  item: number
}

function matchInSection(section: SectionId | '', key: string): string | undefined {
  const scoped = section ? SLOTS.filter(slot => slot.section === section) : SLOTS
  const byAlias = scoped.filter(slot => aliasHit(slot, key) || (Boolean(section) && legacyAliasHit(slot, key)))
  if (!section) return byAlias.length === 1 ? byAlias[0].id : undefined
  if (byAlias.length === 1) return byAlias[0].id
  if (byAlias.length > 1) {
    // 同区块内别名冲突时取排除项未命中的第一个
    const survivors = byAlias.filter(slot => !slot.excludePatterns?.some(pattern => pattern.test(key)))
    return (survivors[0] || byAlias[0]).id
  }
  // 再按正则
  const byPattern = scoped.filter(slot => slot.patterns?.some(pattern => pattern.test(key))
    && !slot.excludePatterns?.some(pattern => pattern.test(key)))
  if (byPattern.length === 1) return byPattern[0].id
  return undefined
}

export function factToSlot(fact: Pick<Fact, 'group' | 'key' | 'item'>): FactSlot {
  const section = sectionOfText(fact.group)
  const item = Math.max(1, fact.item || 1)
  // 区块内匹配优先；区块未知时只接受全局唯一的别名，同名不猜。
  const direct = section ? matchInSection(section, fact.key) : matchInSection('', fact.key)
  const compound = section ? inferQualifiedField({
    sectionId: section, label: fact.key, placeholder: '', group: fact.group
  }) : null
  const slot = direct || compound?.slot
  return { slot, section, item }
}

/** 建立 slot → facts 的索引，供连接阶段查询。 */
export function indexFactsBySlot(facts: Fact[]): Map<string, Fact[]> {
  const index = new Map<string, Fact[]>()
  for (const fact of facts) {
    if (!fact.value.trim()) continue
    const { slot } = factToSlot(fact)
    if (!slot) continue
    const list = index.get(slot) || []
    list.push(fact)
    index.set(slot, list)
  }
  return index
}
