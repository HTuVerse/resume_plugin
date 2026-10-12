import type { FillRequest, FormField } from '../../domain/types'
import { sectionById, sectionOfText } from '../ontology/sections'
import { slotById } from '../ontology/slotRegistry'

export interface FillPhases {
  identity: FillRequest[]
  remaining: FillRequest[]
}

function sectionOf(field: FormField): string {
  return field.sectionId || (field.slot ? slotById(field.slot)?.section : undefined) || sectionOfText(field.group)
}

/**
 * 把批量请求拆成“记录身份字段”和“其余字段”。身份槽位来自板块本体，
 * 不在流程代码里硬编码学校、公司或家庭称谓。
 */
export function splitIdentityFillRequests(values: FillRequest[], fields: FormField[]): FillPhases {
  const byId = new Map(fields.map(field => [field.id, field]))
  const identity: FillRequest[] = []
  const remaining: FillRequest[] = []
  for (const request of values) {
    const field = byId.get(request.fieldId)
    const section = field ? sectionById(sectionOf(field)) : undefined
    const slot = request.slot || field?.slot
    if (slot && section?.recordIdentity?.anchorSlots.includes(slot)) identity.push(request)
    else remaining.push(request)
  }
  return { identity, remaining }
}
