import type { FormField } from '../../domain/types'
import { normalize } from '../../shared/normalize'
import { sectionById } from './sections'
import { slotsBySection } from './slotRegistry'

export interface QualifiedFieldIdentity {
  qualifier: string
  slot?: string
}

/**
 * 解析“记录限定词 + 字段名”式标签。算法只读取板块本体配置：
 * 新增限定词或新的重复板块时无需修改扫描/监测流程。
 */
export function inferQualifiedField(field: Pick<FormField, 'sectionId' | 'label' | 'placeholder' | 'group' | 'nearbyText'>): QualifiedFieldIdentity | null {
  const section = sectionById(field.sectionId)
  const identity = section?.recordIdentity
  if (!section || !identity?.qualifiers?.length) return null
  const sources = [field.label, field.placeholder, field.nearbyText || '', field.group].filter(Boolean)
  for (const source of sources) {
    const compact = source.replace(/\s+/g, '')
    for (const qualifier of identity.qualifiers) {
      const matchedAlias = qualifier.aliases.find(alias => compact.includes(alias.replace(/\s+/g, '')))
      if (!matchedAlias) continue
      if (source !== field.label && field.label.trim()) return { qualifier: qualifier.canonical }
      const remainder = normalize(compact.replace(matchedAlias.replace(/\s+/g, ''), ''))
      if (!remainder) return { qualifier: qualifier.canonical, slot: identity.implicitQualifiedSlot }
      const hits = slotsBySection(section.id).filter(slot => slot.aliases.some(alias => normalize(alias) === remainder))
      return { qualifier: qualifier.canonical, slot: hits.length === 1 ? hits[0].id : undefined }
    }
  }
  return null
}
