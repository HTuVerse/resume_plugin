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
  if (sectionOf(left) !== sectionOf(right)) return false
  if (left.slot && right.slot) return left.slot === right.slot
  const leftLabel = normalize(left.label)
  const rightLabel = normalize(right.label)
  return Boolean(leftLabel && rightLabel && leftLabel === rightLabel)
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

  const peers = fields.filter(candidate => sameSemanticField(field, candidate))
  const occurrence = Math.max(1, peers.findIndex(candidate => candidate.id === field.id) + 1)
  if (!explicit) return occurrence

  // 同一个语义字段出现相同显式段号，说明重复段识别发生了碰撞，改用出现顺序。
  const collision = peers.filter(candidate => Math.max(0, Number(candidate.item) || 0) === explicit).length > 1
  return collision ? occurrence : explicit
}
