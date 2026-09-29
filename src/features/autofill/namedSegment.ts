import type { Fact, FormField } from '../../domain/types'
import { aliasHit, slotById } from '../ontology/slotRegistry'
import { sectionOfText } from '../ontology/sections'
import { normalize } from '../../shared/normalize'

/**
 * 可重复经历按名称对齐。
 * 一段的身份是名称（学校、项目、企业、活动、奖励、证书），不是时间。
 * 时间和其他字段跟着名称走。同名再用该段的结束时间或获奖时间区分。
 */

export type NamedSection = 'education' | 'project' | 'internship' | 'campus' | 'award' | 'certificate'

const NAMED_SECTIONS: NamedSection[] = ['education', 'project', 'internship', 'campus', 'award', 'certificate']

const NAME_SLOT: Record<NamedSection, string> = {
  education: 'education.school',
  project: 'project.name',
  internship: 'internship.company',
  campus: 'campus.name',
  award: 'award.name',
  certificate: 'certificate.name'
}
const DATE_SLOT: Record<NamedSection, string> = {
  education: 'education.endDate',
  project: 'project.endDate',
  internship: 'internship.endDate',
  campus: 'campus.endDate',
  award: 'award.date',
  certificate: 'certificate.date'
}

export function nameSlotId(section: NamedSection): string {
  return NAME_SLOT[section]
}

export function dateSlotId(section: NamedSection): string {
  return DATE_SLOT[section]
}

function asNamed(section: string | undefined): NamedSection | '' {
  return NAMED_SECTIONS.find(id => id === section) || ''
}

export function namedSectionOf(field: Pick<FormField, 'slot' | 'sectionId' | 'group'>): NamedSection | '' {
  const fromSlot = NAMED_SECTIONS.find(id => field.slot?.startsWith(`${id}.`))
  if (fromSlot) return fromSlot
  return asNamed(field.sectionId) || asNamed(sectionOfText(field.group))
}

export interface NamedAlignInput {
  section: NamedSection
  pageItem: number
  /**
   * undefined：页面上没有名称栏。
   * 空串：名称栏在，但还没填。
   */
  name: string | undefined
  date?: string
  facts: Fact[]
}

function pageItemOf(input: NamedAlignInput): number {
  return Math.max(1, input.pageItem || 1)
}

function itemOf(fact: Fact): number {
  return Math.max(1, fact.item || 1)
}

function inSection(facts: Fact[], section: NamedSection): Fact[] {
  return facts.filter(fact => sectionOfText(fact.group) === section)
}

function valueAt(facts: Fact[], section: NamedSection, item: number, slotId: string): string {
  const slot = slotById(slotId)
  if (!slot) return ''
  const hit = inSection(facts, section).find(fact => itemOf(fact) === item && aliasHit(slot, fact.key))
  return hit?.value.trim() || ''
}

export function nextNamedItem(facts: Fact[], section: NamedSection): number {
  const items = inSection(facts, section).map(itemOf)
  return items.length ? Math.max(...items) + 1 : 1
}

/** 同一页面上多段同时对不上时，用页面段号错开，避免都写进同一个新段号。 */
function freshItem(input: NamedAlignInput): number {
  return nextNamedItem(input.facts, input.section) + pageItemOf(input) - 1
}

/**
 * 按名称找知识库段。
 * 没有命中返回 null。多名相同再用时间；仍分不开就用页面段号。
 */
function matchName(input: NamedAlignInput): number | null {
  const wanted = normalize(input.name || '')
  if (!wanted) return null
  const items = [...new Set(inSection(input.facts, input.section).map(itemOf))]
  const hits = items.filter(item => normalize(valueAt(input.facts, input.section, item, NAME_SLOT[input.section])) === wanted)
  if (!hits.length) return null
  if (hits.length === 1) return hits[0]
  const date = normalize(input.date || '')
  if (date) {
    const dated = hits.filter(item => normalize(valueAt(input.facts, input.section, item, DATE_SLOT[input.section])) === date)
    if (dated.length === 1) return dated[0]
  }
  return pageItemOf(input)
}

/**
 * 监测回写用的段号。
 * 名称对上就写回那一段；名称填了但对不上，才在末尾新增一段。
 * 名称栏在但还没填时，仍用页面段号，不另开一段。
 * 页面没有名称栏时，退回页面段号。
 */
export function alignNamedItem(input: NamedAlignInput): number {
  const pageItem = pageItemOf(input)
  if (input.name === undefined || !input.name.trim()) return pageItem
  return matchName(input) ?? freshItem(input)
}

/**
 * 填写用的段号。
 * 名称对上返回知识库段号；名称对不上返回 null，避免把另一段的内容填进来。
 * 名称空着或没有名称栏时返回 undefined，调用方继续用页面段号。
 */
export function fillNamedItem(input: NamedAlignInput): number | null | undefined {
  if (input.name === undefined || !input.name.trim()) return undefined
  return matchName(input)
}
