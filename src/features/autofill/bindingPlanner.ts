import type { FormField } from '../../domain/types'
import { pageSegmentKey } from './pageSegment'
import { subjectSectionOf } from './match/subjectScope'

const PROJECTABLE_KINDS = new Set(['select', 'combobox', 'cascade'])

export interface PlannedValueBinding {
  groupId: string
  shape: 'sequence'
  index: number
  size: number
  factId: string
  previousFieldId?: string
}

/**
 * 同一条知识同时绑定到同一页面区域内的多个选择控件时，把它们提升为一个有序绑定组。
 * 分组依据是既有语义绑定和页面结构，不读取“省、市、区”等业务词。
 */
export function planValueBindings(
  fields: FormField[],
  factIdOf: (field: FormField) => string | undefined
): Map<string, PlannedValueBinding> {
  const planned = new Map<string, PlannedValueBinding>()
  const clusters = new Map<string, FormField[]>()
  for (const field of fields) {
    if (!field.controlClusterId || !PROJECTABLE_KINDS.has(field.kind)) continue
    const clusterKey = `${field.frameId || 0}\u0000${field.controlClusterId}`
    const rows = clusters.get(clusterKey) || []
    rows.push(field)
    clusters.set(clusterKey, rows)
  }
  for (const [clusterId, rows] of clusters) {
    if (rows.length < 2) continue
    // 结构相邻不等于同一主体；跨板块或跨记录的控件不可继承彼此的知识条目。
    const scopes = new Set(rows.map(field => `${subjectSectionOf(field)}\u0000${pageSegmentKey(field, fields)}`))
    if (scopes.size !== 1) continue
    const factIds = [...new Set(rows.map(factIdOf).filter((id): id is string => Boolean(id)))]
    // 一个结构簇中只有唯一已确认知识时，未单独识别的子控件可继承它；
    // 出现两个不同知识绑定则保持独立，禁止猜测。
    if (factIds.length !== 1) continue
    const factId = factIds[0]
    const groupId = `sequence:${clusterId}:${factId}`
    rows.forEach((field, index) => planned.set(field.id, {
      groupId, shape: 'sequence', index, size: rows.length, factId,
      previousFieldId: index ? rows[index - 1].id : undefined
    }))
  }

  const groups = new Map<string, FormField[]>()
  for (const field of fields) {
    if (planned.has(field.id)) continue
    const factId = factIdOf(field)
    if (!factId || !PROJECTABLE_KINDS.has(field.kind)) continue
    const structuralScope = `${subjectSectionOf(field)}\u0000${pageSegmentKey(field, fields)}\u0000${field.group}`
    const key = `${field.frameId || 0}\u0000${structuralScope}\u0000${factId}`
    const rows = groups.get(key) || []
    rows.push(field)
    groups.set(key, rows)
  }

  for (const [key, rows] of groups) {
    if (rows.length < 2) continue
    const groupId = `sequence:${key}`
    rows.forEach((field, index) => planned.set(field.id, {
      groupId,
      shape: 'sequence',
      index,
      size: rows.length,
      factId: factIdOf(field)!,
      previousFieldId: index ? rows[index - 1].id : undefined
    }))
  }
  return planned
}
