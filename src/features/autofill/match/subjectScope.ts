import type { FormField } from '../../../domain/types'
import type { SectionId } from '../../../domain/slots'
import { aliasSectionCount, slotById } from '../../ontology/slotRegistry'
import { SECTIONS, recordQualifierOf, sectionById, sectionOfText } from '../../ontology/sections'

type FieldContext = Pick<FormField, 'label' | 'group'> & Partial<Pick<FormField, 'sectionId' | 'placeholder' | 'nearbyText' | 'slotStatus' | 'slotCandidates'>>

/** 先确定字段所属主体/板块，再在该范围内比较槽位和知识条目的置信度。 */
export function subjectSectionOf(field: FieldContext): SectionId | '' {
  const labelSection = sectionOfText(field.label)
  if (labelSection) return labelSection

  const contextTexts = [field.label, field.group, field.nearbyText || '', field.placeholder || '']
  const qualified = SECTIONS.filter(section => contextTexts.some(text => recordQualifierOf(section.id, text))).map(section => section.id)
  if (qualified.length === 1) return qualified[0]

  const declared = sectionById(field.sectionId)?.id
  const groupSection = sectionOfText(field.group)
  const nearby = sectionOfText(field.nearbyText || '') || sectionOfText(field.placeholder || '')
  const structural = declared || groupSection
  // 结构标题与字段近旁主题冲突时不跨主体猜；由更明确的字段限定词或页面修正决定。
  if (structural && nearby && structural !== nearby) return ''
  return structural || nearby
}

/** 同名字段横跨多个主体而页面没有主体线索时，不进行跨主体猜填。 */
export function hasUnresolvedSubject(field: FieldContext): boolean {
  if (subjectSectionOf(field)) return false
  if (aliasSectionCount(field.label) > 1) return true
  if (field.slotStatus !== 'ambiguous') return false
  const sections = new Set(field.slotCandidates?.map(candidate => slotById(candidate.slot)?.section).filter(Boolean))
  return sections.size > 1
}
