import type { FormField } from '../../domain/types'
import { normalize } from '../../shared/normalize'
import { slotById } from '../ontology/slotRegistry'
import { sectionOfText } from '../ontology/sections'

/** 会按条目重复的板块。 */
const REPEAT_SECTIONS = new Set([
  'education', 'project', 'work', 'internship', 'campus', 'award', 'certificate', 'family'
])

function sectionOf(field: FormField): string {
  return field.sectionId || (field.slot ? slotById(field.slot)?.section : undefined) || sectionOfText(field.group)
}

function sameSemanticField(left: FormField, right: FormField): boolean {
  if ((left.frameId || 0) !== (right.frameId || 0)) return false
  if (sectionOf(left) !== sectionOf(right)) return false
  if (left.slot && right.slot) return left.slot === right.slot
  const leftLabel = normalize(left.label)
  const rightLabel = normalize(right.label)
  return Boolean(leftLabel && rightLabel && leftLabel === rightLabel)
}

function indexedItem(field: FormField, fields: FormField[]): number | undefined {
  const indexed = (value: string | undefined): number | undefined => {
    if (!value) return undefined
    const bracket = [...value.matchAll(/\[(\d+)\]/g)].at(-1)
    if (bracket) return Number(bracket[1])
    const separated = [...value.matchAll(/(?:^|[._-])(\d+)(?=[._-]|$)/g)].at(-1)
    return separated ? Number(separated[1]) : undefined
  }
  const raw = indexed(field.attrs?.name || field.name) ?? indexed(field.attrs?.id)
  if (raw === undefined) return undefined

  const section = sectionOf(field)
  const frameId = field.frameId || 0
  const hints = fields
    .filter(candidate => sectionOf(candidate) === section && (candidate.frameId || 0) === frameId)
    .map(candidate => indexed(candidate.attrs?.name || candidate.name) ?? indexed(candidate.attrs?.id))
    .filter((item): item is number => item !== undefined)
  const occurrences = hints.filter(item => item === raw).length
  const distinct = [...new Set(hints)].sort((a, b) => a - b)
  // 数字必须至少被同一行的两个控件共享，或页面上明确出现多个数组下标。
  // 避免把普通控件 ID 末尾的流水号误当成重复段号。
  if (occurrences < 2 && distinct.length < 2) return undefined
  return distinct.indexOf(raw) + 1
}

/**
 * 返回字段在页面重复板块中的有效段号。
 *
 * 正常情况下直接使用扫描器识别出的 item。某些站点的重复块不是同构兄弟节点，
 * 扫描器拿不到 item（或把多个同名字段都误标成同一个 item）；此时按同板块、
 * 同槽位字段在 DOM 中的出现顺序回退为 1/2/3。这样第二个“项目描述”会取知识库
 * 第 2 段，而不会再次使用第 1 段。
 */
export function pageSegmentItem(field: FormField, fields: FormField[]): number {
  const section = sectionOf(field)
  const explicit = Math.max(0, Number(field.item) || 0)
  if (!REPEAT_SECTIONS.has(section)) return explicit || 1

  const fromArrayPath = indexedItem(field, fields)
  if (!explicit && fromArrayPath) return fromArrayPath

  const peers = fields.filter(candidate => sameSemanticField(field, candidate))
  const occurrence = Math.max(1, peers.findIndex(candidate => candidate.id === field.id) + 1)
  if (!explicit) return occurrence

  // 同一个语义字段出现相同显式段号，说明重复段识别发生了碰撞，改用出现顺序。
  const collision = peers.filter(candidate => Math.max(0, Number(candidate.item) || 0) === explicit).length > 1
  return collision ? occurrence : explicit
}

/** 同一个重复集合中的一个具体段实例。重复组 ID 本身不代表具体段。 */
export function pageSegmentKey(field: FormField, fields: FormField[]): string {
  const section = sectionOf(field)
  const scope = field.repeatGroupId || 'ungrouped'
  return `${field.frameId || 0}:${section}:${scope}:${pageSegmentItem(field, fields)}`
}

export function samePageSegment(left: FormField, right: FormField, fields: FormField[]): boolean {
  return pageSegmentKey(left, fields) === pageSegmentKey(right, fields)
}
