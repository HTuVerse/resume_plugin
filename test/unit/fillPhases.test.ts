import { describe, expect, it } from 'vitest'
import type { FillRequest, FormField } from '../../src/domain/types'
import { splitIdentityFillRequests } from '../../src/features/autofill/fillPhases'

function field(id: string, slot: string, sectionId: string): FormField {
  return {
    id, fingerprint: id, label: id, group: '', sectionId, slot, placeholder: '', kind: 'text',
    options: [], current: '', required: false, maxLength: 0
  }
}

function request(fieldId: string, slot: string): FillRequest {
  return { fieldId, slot, value: fieldId }
}

describe('两阶段填写规划', () => {
  it('学校、公司、家庭称谓等身份字段先填，其余字段后填', () => {
    const fields = [
      field('school', 'education.school', 'education'),
      field('degree', 'education.degree', 'education'),
      field('company', 'work.company', 'work'),
      field('title', 'work.title', 'work'),
      field('relation', 'family.relation', 'family'),
      field('family-name', 'family.name', 'family')
    ]
    const values = fields.map(row => request(row.id, row.slot!))
    const phases = splitIdentityFillRequests(values, fields)
    expect(phases.identity.map(row => row.fieldId)).toEqual(['school', 'company', 'relation'])
    expect(phases.remaining.map(row => row.fieldId)).toEqual(['degree', 'title', 'family-name'])
  })

  it('普通单值字段不会被拆进身份阶段', () => {
    const fields = [field('name', 'personal.name', 'personal')]
    expect(splitIdentityFillRequests([request('name', 'personal.name')], fields).identity).toEqual([])
  })
})
