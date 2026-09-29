import type { Fact, FormField } from '../../domain/types'
import { sectionOfText } from '../ontology/sections'

/**
 * 家庭关系不按页面上的第几段硬套模板顺序。
 * 称谓（父亲 / 母亲）才是同一个人的标识：页面先填妈妈、知识库里爸爸排在前面时，
 * 仍写回母亲那一段，避免把两个人的信息互相覆盖。
 */

const RELATION_ALIASES = /^(关系|与本人关系|称谓|成员关系)$/

const RELATION_CANON: Array<{ canon: string; pattern: RegExp }> = [
  { canon: '父亲', pattern: /父亲|爸爸|老爸|家父/ },
  { canon: '母亲', pattern: /母亲|妈妈|老妈|家母/ },
  { canon: '配偶', pattern: /配偶|丈夫|妻子|老公|老婆/ },
  { canon: '兄弟', pattern: /兄弟|哥哥|弟弟/ },
  { canon: '姐妹', pattern: /姐妹|姐姐|妹妹/ },
  { canon: '子女', pattern: /子女|儿子|女儿/ }
]

export function isFamilyField(field: Pick<FormField, 'slot' | 'sectionId' | 'group'>): boolean {
  if (field.slot?.startsWith('family.')) return true
  if (field.sectionId === 'family') return true
  return sectionOfText(field.group) === 'family'
}

export function isRelationKey(key: string): boolean {
  return RELATION_ALIASES.test(key.replace(/\s+/g, ''))
}

/** 把爸爸/父亲收成同一个称谓。认不出亲属关系时返回空，避免把区块标题当成称谓。 */
export function relationKey(value: string): string {
  const text = String(value || '').replace(/\s+/g, '').trim()
  if (!text || text.length > 8) return ''
  return RELATION_CANON.find(item => item.pattern.test(text))?.canon || ''
}

export function isRelationField(field: Pick<FormField, 'slot' | 'label'>): boolean {
  if (field.slot === 'family.relation') return true
  return isRelationKey(field.label)
}

function familyFacts(facts: Fact[]): Fact[] {
  return facts.filter(fact => sectionOfText(fact.group) === 'family' || /家庭|亲属/.test(fact.group))
}

/** 知识库里称谓相同的那一段。没有则返回 null。 */
export function familyItemForRelation(facts: Fact[], relation: string): number | null {
  const key = relationKey(relation)
  if (!key) return null
  const hit = familyFacts(facts).find(fact => isRelationKey(fact.key) && relationKey(fact.value) === key)
  return hit ? Math.max(1, hit.item || 1) : null
}

export function nextFamilyItem(facts: Fact[]): number {
  const items = familyFacts(facts).map(fact => Math.max(1, fact.item || 1))
  return items.length ? Math.max(...items) + 1 : 1
}

/**
 * 学习入库时决定写到哪一段。
 * 有称谓且知识库已有这个人 → 用那一段，不看页面顺序。
 * 有称谓但还没有这个人 → 新开一段，不覆盖已有的父亲/母亲。
 * 没有称谓 → 仍用页面段号（教育经历等其他重复段不受影响）。
 */
export function alignFamilyItem(pageItem: number, relation: string, facts: Fact[]): number {
  if (!relationKey(relation)) return Math.max(1, pageItem || 1)
  return familyItemForRelation(facts, relation) ?? nextFamilyItem(facts)
}
