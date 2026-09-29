import { describe, expect, it } from 'vitest'
import type { Fact } from '../../src/domain/types'
import { factToSlot, indexFactsBySlot } from '../../src/features/autofill/match/factToSlot'
import { mergeFactsByPriority } from '../../src/features/autofill/factPriority'

function makeFact(partial: Partial<Fact>): Fact {
  return { id: crypto.randomUUID(), group: '基本信息', item: 1, key: '姓名', value: '张三', evidence: '', ...partial }
}

describe('factToSlot（档案侧键名 → 槽位）', () => {
  it('基本信息字段映射', () => {
    expect(factToSlot(makeFact({ group: '基本信息', key: '姓名' })).slot).toBe('personal.name')
    expect(factToSlot(makeFact({ group: '基本信息', key: '移动电话' })).slot).toBe('personal.phone')
    expect(factToSlot(makeFact({ group: '基本信息', key: '电子邮箱' })).slot).toBe('personal.email')
  })
  it('教育经历字段带段号', () => {
    const result = factToSlot(makeFact({ group: '教育经历', key: '学校名称', item: 2 }))
    expect(result.slot).toBe('education.school')
    expect(result.item).toBe(2)
  })
  it('「姓名」在家庭关系区块 → family.name，不与 personal.name 混淆', () => {
    expect(factToSlot(makeFact({ group: '家庭关系', key: '姓名' })).slot).toBe('family.name')
  })
  it('「毕业时间」按区块归属，没有板块时不猜', () => {
    expect(factToSlot(makeFact({ group: '基本信息', key: '毕业时间' })).slot).toBe('personal.graduationDate')
    expect(factToSlot(makeFact({ group: '基本信息', key: '预计毕业时间' })).slot).toBe('personal.graduationDate')
    expect(factToSlot(makeFact({ group: '教育经历', key: '毕业时间' })).slot).toBe('education.endDate')
    expect(factToSlot(makeFact({ group: '其他', key: '开始时间' })).slot).toBeUndefined()
    expect(factToSlot(makeFact({ group: '其他', key: '毕业时间' })).slot).toBe('education.endDate')
  })
})

describe('mergeFactsByPriority（知识库为唯一数据源）', () => {
  it('只返回知识库内容，简历事实不参与填充', () => {
    const profile = [makeFact({ group: '基本信息', key: '移动电话', value: '13800138000' })]
    const resume = [makeFact({ group: '基本信息', key: '电子邮箱', value: 'a@b.com' })]
    const merged = mergeFactsByPriority(profile, resume)
    expect(merged).toHaveLength(1)
    expect(merged[0].value).toBe('13800138000')
    expect(merged[0].source).toBe('profile')
  })
  it('空值不参与', () => {
    const profile = [makeFact({ key: '姓名', value: '张三' }), makeFact({ key: '电子邮箱', value: '  ' })]
    expect(mergeFactsByPriority(profile)).toHaveLength(1)
  })
})

describe('indexFactsBySlot', () => {
  it('按槽位索引且跳过空值', () => {
    const index = indexFactsBySlot([
      makeFact({ key: '姓名', value: '张三' }),
      makeFact({ key: '姓名', value: '' }),
      makeFact({ group: '教育经历', key: '学校名称', value: '示例大学' })
    ])
    expect(index.get('personal.name')).toHaveLength(1)
    expect(index.get('education.school')).toHaveLength(1)
  })
})
