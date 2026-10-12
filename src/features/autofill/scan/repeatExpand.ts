import type { Fact, FormField } from '../../../domain/types'
import { sectionOfText } from '../../ontology/sections'
import { namedSectionOf, type NamedSection } from '../namedSegment'

/** 这些板块在页面上通常有「新增一段」。一次最多补 8 段，避免按钮点不动时死循环。 */
type ExpandableSection = NamedSection | 'family'
const EXPANDABLE: ExpandableSection[] = ['education', 'work', 'project', 'internship', 'campus', 'award', 'certificate', 'family']
const MAX_CLICKS = 8

export interface RepeatDemand {
  section: ExpandableSection
  missing: number
}

function profileItemCount(facts: Fact[], section: string): number {
  const items = facts
    .filter(fact => fact.value.trim() && sectionOfText(fact.group) === section)
    .map(fact => Math.max(1, fact.item || 1))
  return items.length ? Math.max(...items) : 0
}

function pageBlockCount(fields: FormField[], section: string): number {
  const rows = fields.filter(field => field.sectionId === section || namedSectionOf(field) === section || sectionOfText(field.group) === section)
  if (!rows.length) return 0
  const items = rows.map(field => field.item).filter((item): item is number => typeof item === 'number' && item > 0)
  return items.length ? Math.max(...items) : 1
}

/**
 * 档案里的段数多于页面上已经渲染的块数时，返回还要补几段。
 * 页面上没有这个板块时不补，避免去点别的区域的按钮。
 */
export function planRepeatExpansion(fields: FormField[], facts: Fact[]): RepeatDemand[] {
  const demands: RepeatDemand[] = []
  for (const section of EXPANDABLE) {
    const pageBlocks = pageBlockCount(fields, section)
    if (!pageBlocks) continue
    const profileItems = profileItemCount(facts, section)
    if (profileItems <= pageBlocks) continue
    demands.push({ section, missing: Math.min(MAX_CLICKS, profileItems - pageBlocks) })
  }
  return demands
}
