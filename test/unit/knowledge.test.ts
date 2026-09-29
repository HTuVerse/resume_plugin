import { describe, expect, it } from 'vitest'
import type { Fact, FormField } from '../../src/domain/types'
import {
  canonicalGroupName, canonicalizeFact, canonicalizeFacts,
  classifyPageInput, mergeIntoKnowledge
} from '../../src/features/rag/knowledge'

function makeFact(partial: Partial<Fact>): Fact {
  return { id: crypto.randomUUID(), group: '基本信息', item: 1, key: '姓名', value: '张三', evidence: '', ...partial }
}

function makeField(partial: Partial<FormField>): FormField {
  return {
    id: 'f1', fingerprint: 'f1', label: '', group: '', placeholder: '', kind: 'text',
    options: [], current: '', required: false, maxLength: 0,
    ...partial
  }
}

describe('canonicalGroupName（分组归一）', () => {
  it('变体分组名归一到规范板块名', () => {
    expect(canonicalGroupName('教育背景')).toBe('教育经历')
    expect(canonicalGroupName('社会实践 · 校内活动')).toBe('社会实践 / 校内活动')
    expect(canonicalGroupName('工作经历')).toBe('实习经历')
  })
  it('无法识别时原样返回，空值归入其他', () => {
    expect(canonicalGroupName('特殊板块')).toBe('特殊板块')
    expect(canonicalGroupName('')).toBe('其他')
  })
})

describe('canonicalizeFact（字段名槽位归一）', () => {
  it('槽位命中时归一 key 与 group（手机号 → 移动电话）', () => {
    const fact = canonicalizeFact(makeFact({ group: '个人信息', key: '手机号', value: '13800138000' }))
    expect(fact.key).toBe('移动电话')
    expect(fact.group).toBe('基本信息')
  })
  it('自定义字段保留原键名，仅归一分组', () => {
    const fact = canonicalizeFact(makeFact({ group: '教育背景', key: 'GPA 排名', value: '前 5%' }))
    expect(fact.key).toBe('GPA 排名')
    expect(fact.group).toBe('教育经历')
  })
  it('批量归一后按 (板块,条目,字段,值) 去重（AI 与规则提取重复项合并）', () => {
    const merged = canonicalizeFacts([
      makeFact({ key: '手机号', value: '13800138000' }),
      makeFact({ key: '移动电话', value: '13800138000' })
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].key).toBe('移动电话')
  })
})

describe('classifyPageInput（网页学习分类）', () => {
  it('槽位已识别 → 按槽位规范名归类', () => {
    const field = makeField({ label: '毕业院校', slot: 'education.school', item: 2 })
    const entry = classifyPageInput(field, '清华大学')
    expect(entry?.custom).toBe(false)
    expect(entry?.fact.group).toBe('教育经历')
    expect(entry?.fact.key).toBe('学校名称')
    expect(entry?.fact.item).toBe(2)
  })
  it('未识别槽位 → 按字段标签保存为自定义字段，按区块归组', () => {
    const field = makeField({ label: '内部推荐人工号', sectionId: 'personal' })
    const entry = classifyPageInput(field, 'E12345')
    expect(entry?.custom).toBe(true)
    expect(entry?.fact.group).toBe('基本信息')
    expect(entry?.fact.key).toBe('内部推荐人工号')
  })
  it('空值 / 无标签的输入不入库', () => {
    expect(classifyPageInput(makeField({ label: '某字段' }), '   ')).toBeNull()
    expect(classifyPageInput(makeField({ label: '' }), '有值')).toBeNull()
  })
  it('页面板块与槽位不一致时，改回该板块的同名槽位', () => {
    const field = makeField({
      label: '开始时间', slot: 'project.startDate', sectionId: 'internship', item: 2
    })
    const entry = classifyPageInput(field, '2024-03')
    expect(entry?.slot).toBe('internship.startDate')
    expect(entry?.fact.group).toBe('实习经历')
    expect(entry?.fact.key).toBe('开始时间')
    expect(entry?.fact.item).toBe(2)
  })
  it('本板块没有同名槽位时，记成该板块的自定义字段，不写进别的板块', () => {
    const field = makeField({
      label: '活动名称', slot: 'campus.name', sectionId: 'internship'
    })
    const entry = classifyPageInput(field, '支教')
    expect(entry?.custom).toBe(true)
    expect(entry?.slot).toBeUndefined()
    expect(entry?.fact.group).toBe('实习经历')
    expect(entry?.fact.key).toBe('活动名称')
  })
})

describe('mergeIntoKnowledge（知识库合并）', () => {
  it('同 (板块,条目,字段) 更新并保留原 id，否则新增；不删除既有信息', () => {
    const existing = [
      makeFact({ id: 'keep-1', key: '姓名', value: '张三' }),
      makeFact({ id: 'keep-2', key: '电子邮箱', value: 'a@b.com' })
    ]
    const result = mergeIntoKnowledge(existing, [
      makeFact({ key: '姓名', value: '李四' }),
      makeFact({ group: '教育经历', key: '学校名称', value: '北京大学' })
    ])
    expect(result.updated).toBe(1)
    expect(result.added).toBe(1)
    expect(result.facts).toHaveLength(3)
    const name = result.facts.find(fact => fact.key === '姓名')
    expect(name?.id).toBe('keep-1')
    expect(name?.value).toBe('李四')
    expect(result.facts.some(fact => fact.key === '电子邮箱')).toBe(true)
  })
  it('奖励荣誉和在校获奖荣誉是同一段，更新时不改原分组名', () => {
    const existing = [makeFact({ id: 'award-1', group: '奖励荣誉', item: 2, key: '获奖时间', value: '2020-06' })]
    const result = mergeIntoKnowledge(existing, [
      makeFact({ group: '在校获奖荣誉', item: 2, key: '获奖时间', value: '2021-09' })
    ])
    expect(result.updated).toBe(1)
    expect(result.added).toBe(0)
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].id).toBe('award-1')
    expect(result.facts[0].group).toBe('奖励荣誉')
    expect(result.facts[0].value).toBe('2021-09')
  })
})
