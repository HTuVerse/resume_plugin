import { describe, expect, it } from 'vitest'
import type { Fact, FormField } from '../../src/domain/types'
import { bindObservedRepeatRecords, bindRepeatRecords, buildPageRepeatBlocks } from '../../src/features/autofill/repeatBinding'

function field(partial: Partial<FormField>): FormField {
  return {
    id: 'f', fingerprint: 'f', label: '', group: '教育经历', sectionId: 'education',
    placeholder: '', kind: 'text', options: [], current: '', required: false, maxLength: 0,
    ...partial
  }
}

function fact(partial: Partial<Fact>): Fact {
  return { id: 'x', group: '教育经历', item: 1, key: '学校名称', value: '甲大学', evidence: '', ...partial }
}

describe('重复区块记录绑定', () => {
  it('同一区块的不同字段共享同一条记录', () => {
    const fields = [
      field({ id: 'school-1', label: '学校名称', slot: 'education.school' }),
      field({ id: 'degree-1', label: '学历', slot: 'education.degree' }),
      field({ id: 'school-2', label: '学校名称', slot: 'education.school' }),
      field({ id: 'degree-2', label: '学历', slot: 'education.degree' })
    ]
    const facts = [
      fact({ item: 1, value: '甲大学' }), fact({ id: 'd1', item: 1, key: '学历', value: '本科' }),
      fact({ id: 's2', item: 2, value: '乙高中' }), fact({ id: 'd2', item: 2, key: '学历', value: '高中' })
    ]
    const bindings = bindRepeatRecords(fields, facts)
    expect(fields.map(row => bindings.get(row.id))).toEqual([1, 1, 2, 2])
  })

  it('同一重复组 ID 下仍按具体 item 隔离段实例', () => {
    const fields = [
      field({ id: 'school-1', label: '学校名称', slot: 'education.school', item: 1, repeatGroupId: 'education-list' }),
      field({ id: 'degree-1', label: '学历', slot: 'education.degree', item: 1, repeatGroupId: 'education-list' }),
      field({ id: 'school-2', label: '学校名称', slot: 'education.school', item: 2, repeatGroupId: 'education-list' }),
      field({ id: 'degree-2', label: '学历', slot: 'education.degree', item: 2, repeatGroupId: 'education-list' })
    ]
    expect(buildPageRepeatBlocks(fields).map(block => block.fields.map(row => row.id))).toEqual([
      ['school-1', 'degree-1'], ['school-2', 'degree-2']
    ])
  })

  it('页面家庭顺序与档案相反时按称谓绑定', () => {
    const fields = [
      field({ id: 'relation-1', group: '家庭关系', sectionId: 'family', label: '关系', slot: 'family.relation', current: '母亲' }),
      field({ id: 'name-1', group: '家庭关系', sectionId: 'family', label: '姓名', slot: 'family.name' }),
      field({ id: 'relation-2', group: '家庭关系', sectionId: 'family', label: '关系', slot: 'family.relation', current: '父亲' }),
      field({ id: 'name-2', group: '家庭关系', sectionId: 'family', label: '姓名', slot: 'family.name' })
    ]
    const facts = [
      fact({ group: '家庭关系', item: 1, key: '关系', value: '父亲' }),
      fact({ id: 'dad', group: '家庭关系', item: 1, key: '姓名', value: '张父' }),
      fact({ id: 'r2', group: '家庭关系', item: 2, key: '关系', value: '母亲' }),
      fact({ id: 'mom', group: '家庭关系', item: 2, key: '姓名', value: '李母' })
    ]
    const bindings = bindRepeatRecords(fields, facts)
    expect(fields.map(row => bindings.get(row.id))).toEqual([2, 2, 1, 1])
  })

  it('监测时可用复合标签限定词对齐记录，无需页面另设关系字段', () => {
    const fields = [
      field({ id: 'mom', group: '家庭关系', sectionId: 'family', label: '妈妈', slot: 'family.name', recordQualifier: '母亲', current: '李母', item: 1 }),
      field({ id: 'dad', group: '家庭关系', sectionId: 'family', label: '父亲姓名', slot: 'family.name', recordQualifier: '父亲', current: '张父', item: 2 })
    ]
    const facts = [
      fact({ group: '家庭关系', item: 1, key: '关系', value: '父亲' }),
      fact({ id: 'dad-name', group: '家庭关系', item: 1, key: '姓名', value: '张父' }),
      fact({ id: 'mother', group: '家庭关系', item: 2, key: '关系', value: '母亲' }),
      fact({ id: 'mom-name', group: '家庭关系', item: 2, key: '姓名', value: '李母' })
    ]
    const bindings = bindObservedRepeatRecords(fields, facts)
    expect(bindings.get('mom')).toBe(2)
    expect(bindings.get('dad')).toBe(1)
  })

  it('监测多段但没有可靠锚点时不按顺序猜测覆盖', () => {
    const fields = [
      field({ id: 'degree-1', label: '学历', slot: 'education.degree' }),
      field({ id: 'degree-2', label: '学历', slot: 'education.degree' })
    ]
    const facts = [
      fact({ item: 1, value: '甲大学' }),
      fact({ id: 'school-2', item: 2, value: '乙大学' })
    ]
    const bindings = bindObservedRepeatRecords(fields, facts)
    expect(bindings.get('degree-1')).toBeNull()
    expect(bindings.get('degree-2')).toBeNull()
  })

  it('多个全新锚点获得不同的新条目号', () => {
    const fields = [
      field({ id: 'school-1', label: '学校名称', slot: 'education.school', current: '新大学一' }),
      field({ id: 'school-2', label: '学校名称', slot: 'education.school', current: '新大学二' })
    ]
    const bindings = bindObservedRepeatRecords(fields, [fact({ item: 1, value: '旧大学' })])
    expect(bindings.get('school-1')).toBe(2)
    expect(bindings.get('school-2')).toBe(3)
  })

  it('同一条档案记录不能被两个页面区块重复使用', () => {
    const fields = [
      field({ id: 'school-1', label: '学校名称', slot: 'education.school', current: '甲大学' }),
      field({ id: 'school-2', label: '学校名称', slot: 'education.school', current: '甲大学' })
    ]
    const bindings = bindRepeatRecords(fields, [fact({ item: 1, value: '甲大学' })])
    expect(bindings.get('school-1')).toBe(1)
    expect(bindings.get('school-2')).toBeNull()
  })

  it('数组式 name 可在 DOM 结构不规则时提供段号', () => {
    const fields = [
      field({ id: 's0', label: '学校名称', slot: 'education.school', attrs: { name: 'education[0].school' } }),
      field({ id: 'd0', label: '学历', slot: 'education.degree', attrs: { name: 'education[0].degree' } }),
      field({ id: 's1', label: '学校名称', slot: 'education.school', attrs: { name: 'education[1].school' } })
    ]
    expect(buildPageRepeatBlocks(fields).map(block => block.fields.map(row => row.id))).toEqual([
      ['s0', 'd0'], ['s1']
    ])
  })

  it('只有工作板块时可绑定旧实习分组中的记录', () => {
    const fields = [field({ id: 'company', group: '工作经历', sectionId: 'work', label: '公司名称', slot: 'work.company' })]
    const facts = [fact({ group: '实习经历', item: 1, key: '企业名称', value: '示例公司' })]
    expect(bindRepeatRecords(fields, facts).get('company')).toBeNull()
    expect(bindRepeatRecords(fields, facts, { legacyWorkFallback: true }).get('company')).toBe(1)
  })

  it('后面的明确身份段先绑定，前面的空白段使用剩余记录', () => {
    const fields = [
      field({ id: 'school-blank', label: '学校名称', slot: 'education.school' }),
      field({ id: 'school-known', label: '学校名称', slot: 'education.school', current: '甲大学' })
    ]
    const facts = [fact({ item: 1, value: '甲大学' }), fact({ id: 's2', item: 2, value: '乙大学' })]
    const bindings = bindRepeatRecords(fields, facts)
    expect(bindings.get('school-blank')).toBe(2)
    expect(bindings.get('school-known')).toBe(1)
  })

  it('同名学校使用毕业时间区分记录', () => {
    const fields = [
      field({ id: 'school', label: '学校名称', slot: 'education.school', current: '实验学校' }),
      field({ id: 'end', label: '毕业时间', slot: 'education.endDate', current: '2024-06' })
    ]
    const facts = [
      fact({ item: 1, value: '实验学校' }), fact({ id: 'e1', item: 1, key: '毕业时间', value: '2021-06' }),
      fact({ id: 's2', item: 2, value: '实验学校' }), fact({ id: 'e2', item: 2, key: '毕业时间', value: '2024-06' })
    ]
    const bindings = bindRepeatRecords(fields, facts)
    expect(bindings.get('school')).toBe(2)
    expect(bindings.get('end')).toBe(2)
  })

  it('复合标签里的记录限定词可直接绑定家庭成员', () => {
    const fields = [
      field({ id: 'mother-name', group: '家庭关系', sectionId: 'family', label: '姓名', slot: 'family.name', recordQualifier: '母亲' })
    ]
    const facts = [
      fact({ group: '家庭关系', item: 1, key: '关系', value: '父亲' }),
      fact({ id: 'r2', group: '家庭关系', item: 2, key: '关系', value: '妈妈' }),
      fact({ id: 'n2', group: '家庭关系', item: 2, key: '姓名', value: '李母' })
    ]
    expect(bindRepeatRecords(fields, facts).get('mother-name')).toBe(2)
  })
})
