import type { Fact, FormField } from '../../domain/types'
import { sectionById, sectionOfText } from '../ontology/sections'
import { aliasHit, slotById } from '../ontology/slotRegistry'
import { semanticValuesMatch } from '../ontology/valueSemantics'
import { factToSlot } from './match/factToSlot'
import { pageSegmentItem, pageSegmentKey } from './pageSegment'

const REPEAT_SECTIONS = new Set([
  'education', 'project', 'work', 'internship', 'campus', 'award', 'certificate', 'family'
])

export interface PageRepeatBlock {
  id: string
  section: string
  pageItem: number
  fields: FormField[]
}

export interface RepeatBindingOptions {
  /** 工作页面兼容仍存放在旧「实习经历」分组中的档案。 */
  legacyWorkFallback?: boolean
}

function sectionOf(field: FormField): string {
  return field.sectionId || (field.slot ? slotById(field.slot)?.section : undefined) || sectionOfText(field.group)
}

function recordItems(facts: Fact[], section: string): number[] {
  return [...new Set(facts
    .filter(fact => fact.value.trim() && sectionOfText(fact.group) === section)
    .map(fact => Math.max(1, fact.item || 1)))]
    .sort((a, b) => a - b)
}

/**
 * 先把字段聚合成页面记录。后续匹配以整段为单位，禁止同一段里的字段各算各的段号。
 */
export function buildPageRepeatBlocks(fields: FormField[]): PageRepeatBlock[] {
  const blocks = new Map<string, PageRepeatBlock>()
  for (const field of fields) {
    const section = sectionOf(field)
    if (!REPEAT_SECTIONS.has(section)) continue
    const pageItem = pageSegmentItem(field, fields)
    const id = pageSegmentKey(field, fields)
    const block = blocks.get(id) || { id, section, pageItem, fields: [] }
    block.fields.push(field)
    blocks.set(id, block)
  }
  return [...blocks.values()].sort((left, right) => {
    const leftIndex = fields.findIndex(field => field.id === left.fields[0]?.id)
    const rightIndex = fields.findIndex(field => field.id === right.fields[0]?.id)
    return leftIndex - rightIndex
  })
}

function valueOf(block: PageRepeatBlock, slotId: string): string {
  const slot = slotById(slotId)
  const hits = block.fields.filter(field => field.slot === slotId || Boolean(slot && aliasHit(slot, field.label)))
  return hits.map(field => field.current.trim()).find(Boolean) || ''
}

function factValue(facts: Fact[], section: string, item: number, slotId: string): string {
  return facts.find(fact => sectionOfText(fact.group) === section
    && Math.max(1, fact.item || 1) === item
    && factToSlot(fact).slot === slotId)?.value.trim() || ''
}

interface AnchorSignal { slot: string; value: string }
type AnchorMatch = { status: 'matched'; item: number } | { status: 'no-anchor' | 'unmatched' | 'ambiguous' }

function anchorSignals(block: PageRepeatBlock, secondary = false): AnchorSignal[] {
  const identity = sectionById(block.section)?.recordIdentity
  if (!identity) return []
  const slots = secondary ? identity.discriminatorSlots || [] : identity.anchorSlots
  const signals = slots.map(slot => ({ slot, value: valueOf(block, slot) })).filter(signal => signal.value)
  if (!secondary && identity.qualifierSlot) {
    const qualifier = block.fields.map(field => field.recordQualifier || '').find(Boolean)
    if (qualifier && !signals.some(signal => signal.slot === identity.qualifierSlot)) {
      signals.push({ slot: identity.qualifierSlot, value: qualifier })
    }
  }
  return signals
}

function matchingItem(block: PageRepeatBlock, facts: Fact[], items: number[]): AnchorMatch {
  const anchors = anchorSignals(block)
  if (!anchors.length) return { status: 'no-anchor' }
  let hits = items.filter(item => anchors.every(signal => {
    const stored = factValue(facts, block.section, item, signal.slot)
    return Boolean(stored) && semanticValuesMatch(stored, signal.value, { slot: slotById(signal.slot) })
  }))
  if (hits.length > 1) {
    const discriminators = anchorSignals(block, true)
    if (discriminators.length) {
      hits = hits.filter(item => discriminators.every(signal => {
        const stored = factValue(facts, block.section, item, signal.slot)
        return Boolean(stored) && semanticValuesMatch(stored, signal.value, { slot: slotById(signal.slot) })
      }))
    }
  }
  if (hits.length === 1) return { status: 'matched', item: hits[0] }
  return { status: hits.length ? 'ambiguous' : 'unmatched' }
}

/**
 * 页面区块与知识库记录做一对一绑定。
 * 返回 null 表示该区块没有唯一对应记录，调用方必须留空，不能回退第一段。
 */
export function bindRepeatRecords(fields: FormField[], facts: Fact[], options: RepeatBindingOptions = {}): Map<string, number | null> {
  const result = new Map<string, number | null>()
  const blocks = buildPageRepeatBlocks(fields)
  for (const section of [...new Set(blocks.map(block => block.section))]) {
    const sectionBlocks = blocks.filter(block => block.section === section)
    const directItems = recordItems(facts, section)
    const useLegacyWork = section === 'work' && !directItems.length && options.legacyWorkFallback
    const matchingFacts = useLegacyWork
      ? facts.map(fact => sectionOfText(fact.group) === 'internship' ? { ...fact, group: '工作经历' } : fact)
      : facts
    const items = useLegacyWork ? recordItems(matchingFacts, section) : directItems
    const rows = sectionBlocks.map((block, ordinal) => ({ block, ordinal, match: matchingItem(block, matchingFacts, items) }))
    const occupied = new Set<number>()
    const assignments = new Map<string, number | null>()

    // 明确带锚点的段先占位，防止前面的空白段按顺序抢走后面已经能唯一识别的记录。
    for (const row of rows.filter(candidate => candidate.match.status === 'matched')) {
      const candidate = row.match.status === 'matched' ? row.match.item : null
      const item = candidate !== null && !occupied.has(candidate) ? candidate : null
      assignments.set(row.block.id, item)
      if (item !== null) occupied.add(item)
    }
    for (const row of rows.filter(candidate => candidate.match.status !== 'matched')) {
      let item: number | null = null
      if (row.match.status === 'no-anchor') {
        const preferred = items[row.ordinal]
        item = preferred !== undefined && !occupied.has(preferred)
          ? preferred
          : items.find(candidate => !occupied.has(candidate)) ?? null
      }
      assignments.set(row.block.id, item)
      if (item !== null) occupied.add(item)
    }
    for (const block of sectionBlocks) {
      const item = assignments.get(block.id) ?? null
      for (const field of block.fields) result.set(field.id, item)
    }
  }
  return result
}

/**
 * 网页监测用绑定。已有多段且没有记录锚点时不按顺序猜；明确的新锚点则为整段分配唯一新条目。
 */
export function bindObservedRepeatRecords(fields: FormField[], facts: Fact[]): Map<string, number | null> {
  const result = new Map<string, number | null>()
  const blocks = buildPageRepeatBlocks(fields)
  const used = new Map<string, Set<number>>()
  const nextItems = new Map<string, number>()
  const blockCounts = new Map<string, number>()
  for (const block of blocks) blockCounts.set(block.section, (blockCounts.get(block.section) || 0) + 1)

  for (const block of blocks) {
    const items = recordItems(facts, block.section)
    const match = matchingItem(block, facts, items)
    const occupied = used.get(block.section) || new Set<number>()
    let item: number | null = null
    if (match.status === 'matched' && !occupied.has(match.item)) item = match.item
    else if (match.status === 'unmatched') {
      const next = nextItems.get(block.section) || (items.length ? Math.max(...items) + 1 : 1)
      item = next
      nextItems.set(block.section, next + 1)
    } else if (match.status === 'no-anchor') {
      if (!items.length) {
        const next = nextItems.get(block.section) || 1
        item = next
        nextItems.set(block.section, next + 1)
      } else if (blockCounts.get(block.section) === 1 && items.length === 1 && !occupied.has(items[0])) {
        item = items[0]
      }
    }
    if (item !== null) occupied.add(item)
    used.set(block.section, occupied)
    for (const field of block.fields) result.set(field.id, item)
  }
  return result
}
