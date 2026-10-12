import { describe, expect, it } from 'vitest'
import type { Fact, FormField } from '../../src/domain/types'
import { planRepeatExpansion } from '../../src/features/autofill/scan/repeatExpand'

function field(partial: Partial<FormField>): FormField {
  return {
    id: 'f', fingerprint: 'f', label: '学校名称', group: '教育经历', placeholder: '', kind: 'text',
    options: [], current: '', required: false, maxLength: 0, sectionId: 'education', ...partial
  }
}

function fact(partial: Partial<Fact>): Fact {
  return { id: 'a', group: '教育经历', item: 1, key: '学校名称', value: '甲大学', evidence: '', ...partial }
}

describe('planRepeatExpansion', () => {
  it('档案三段、页面一块时要补两段', () => {
    const fields = [field({ item: undefined })]
    const facts = [fact({ item: 1 }), fact({ id: 'b', item: 2, value: '乙大学' }), fact({ id: 'c', item: 3, value: '丙大学' })]
    expect(planRepeatExpansion(fields, facts)).toEqual([{ section: 'education', missing: 2 }])
  })
  it('页面段数已经够时不补', () => {
    const fields = [field({ item: 1 }), field({ id: 'f2', item: 2 })]
    const facts = [fact({ item: 1 }), fact({ id: 'b', item: 2 })]
    expect(planRepeatExpansion(fields, facts)).toEqual([])
  })
  it('页面上没有该板块时不补', () => {
    expect(planRepeatExpansion([], [fact({ item: 1 }), fact({ id: 'b', item: 2 })])).toEqual([])
  })
  it('家庭关系也会按档案条目数补段', () => {
    const familyField = field({ label: '姓名', group: '家庭关系', sectionId: 'family', slot: 'family.name', item: undefined })
    const familyFacts = [
      fact({ group: '家庭关系', item: 1, key: '关系', value: '父亲' }),
      fact({ id: 'mom', group: '家庭关系', item: 2, key: '关系', value: '母亲' })
    ]
    expect(planRepeatExpansion([familyField], familyFacts)).toEqual([{ section: 'family', missing: 1 }])
  })
})
