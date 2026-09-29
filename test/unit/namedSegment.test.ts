import { describe, expect, it } from 'vitest'
import type { Fact } from '../../src/domain/types'
import { decideSlot, scoreFieldSlots } from '../../src/features/autofill/match/fieldToSlot'
import { alignNamedItem, fillNamedItem } from '../../src/features/autofill/namedSegment'
import { sectionOfText } from '../../src/features/ontology/sections'
import { promptFieldSchema } from '../../src/features/ontology/slotRegistry'

function fact(partial: Partial<Fact>): Fact {
  return { id: crypto.randomUUID(), group: '在校获奖荣誉', item: 1, key: '奖励名称', value: '', evidence: '', ...partial }
}

const awards = [
  fact({ item: 1, key: '奖励名称', value: '国家奖学金' }),
  fact({ item: 1, key: '获奖时间', value: '2020-06' }),
  fact({ item: 2, key: '奖励名称', value: '校级三好学生' }),
  fact({ item: 2, key: '获奖时间', value: '2021-05' })
]

describe('获奖与证书分板块', () => {
  it('在校获奖、旧名和荣誉证书仍是获奖，资格证书单独成节', () => {
    expect(sectionOfText('在校获奖荣誉')).toBe('award')
    expect(sectionOfText('奖励荣誉')).toBe('award')
    expect(sectionOfText('荣誉证书')).toBe('award')
    expect(sectionOfText('获奖证书')).toBe('award')
    expect(sectionOfText('证书')).toBe('certificate')
    expect(sectionOfText('资格证书')).toBe('certificate')
    expect(sectionOfText('技能证书')).toBe('certificate')
    expect(sectionOfText('技能 / 爱好')).toBe('skill')
  })
  it('抽取词表带上两个板块，获得时间不会当成获奖时间', () => {
    const schema = promptFieldSchema()
    expect(schema).toContain('在校获奖荣誉')
    expect(schema).toContain('证书：证书名称')
    const awardDate = decideSlot(scoreFieldSlots({
      id: 'a', fingerprint: 'a', label: '获奖时间', group: '在校获奖荣誉', sectionId: 'award',
      placeholder: '', kind: 'text', options: [], current: '', required: false, maxLength: 0
    }))
    const certDate = decideSlot(scoreFieldSlots({
      id: 'c', fingerprint: 'c', label: '获得时间', group: '证书', sectionId: 'certificate',
      placeholder: '', kind: 'text', options: [], current: '', required: false, maxLength: 0
    }))
    expect(awardDate.slot).toBe('award.date')
    expect(certDate.slot).toBe('certificate.date')
  })
})

describe('获奖和证书按名称对齐', () => {
  it('页面顺序反过来时，获奖时间写回名称相同的那一段', () => {
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '校级三好学生', date: '2021-05', facts: awards
    })).toBe(2)
  })
  it('名称对不上就新开一段，不覆盖已有的奖', () => {
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '优秀学生干部', facts: awards
    })).toBe(3)
  })
  it('同一页第二段也是新名称时，段号错开', () => {
    expect(alignNamedItem({
      section: 'award', pageItem: 2, name: '竞赛一等奖', facts: awards
    })).toBe(4)
  })
  it('只改了时间、名称还空时，仍用页面段号，不另开一段', () => {
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '', facts: awards
    })).toBe(1)
  })
  it('名称随后对上后，并回原来的那段', () => {
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '国家奖学金', date: '2024-01', facts: awards
    })).toBe(1)
  })
  it('没有名称栏时仍用页面段号', () => {
    expect(alignNamedItem({
      section: 'award', pageItem: 2, name: undefined, facts: awards
    })).toBe(2)
  })
  it('两段名称相同时，用时间区分；时间也分不开就用页面段号', () => {
    const sameName = [
      fact({ item: 1, key: '奖励名称', value: '奖学金' }),
      fact({ item: 1, key: '获奖时间', value: '2020-01' }),
      fact({ item: 2, key: '奖励名称', value: '奖学金' }),
      fact({ item: 2, key: '获奖时间', value: '2022-03' })
    ]
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '奖学金', date: '2022-03', facts: sameName
    })).toBe(2)
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '奖学金', facts: sameName
    })).toBe(1)
  })
  it('旧分组名奖励荣誉里的名称同样能对上', () => {
    const legacy = [fact({ group: '奖励荣誉', item: 2, key: '奖励名称', value: '国家奖学金' })]
    expect(alignNamedItem({
      section: 'award', pageItem: 1, name: '国家奖学金', facts: legacy
    })).toBe(2)
  })
  it('填写时名称对不上就留空，名称空着则沿用页面段号', () => {
    expect(fillNamedItem({
      section: 'award', pageItem: 1, name: '没有的奖', facts: awards
    })).toBeNull()
    expect(fillNamedItem({
      section: 'award', pageItem: 2, name: '', facts: awards
    })).toBeUndefined()
    expect(fillNamedItem({
      section: 'certificate', pageItem: 1, name: '英语六级', facts: [
        fact({ group: '证书', item: 2, key: '证书名称', value: '英语六级' })
      ]
    })).toBe(2)
  })
})

describe('教育、项目、实习、校内活动按名称对齐', () => {
  const schools = [
    fact({ group: '教育经历', item: 1, key: '学校名称', value: '本科大学' }),
    fact({ group: '教育经历', item: 1, key: '毕业时间', value: '2022-06' }),
    fact({ group: '教育经历', item: 2, key: '学校名称', value: '硕士大学' }),
    fact({ group: '教育经历', item: 2, key: '毕业时间', value: '2025-06' })
  ]
  it('页面第一段是硕士时，入学时间写回学校名称相同的那段', () => {
    expect(alignNamedItem({
      section: 'education', pageItem: 1, name: '硕士大学', date: '2025-06', facts: schools
    })).toBe(2)
    expect(fillNamedItem({
      section: 'education', pageItem: 1, name: '硕士大学', facts: schools
    })).toBe(2)
  })
  it('学校名称对不上就新开一段；填写时对不上则留空', () => {
    expect(alignNamedItem({
      section: 'education', pageItem: 1, name: '另一所大学', facts: schools
    })).toBe(3)
    expect(fillNamedItem({
      section: 'education', pageItem: 1, name: '另一所大学', facts: schools
    })).toBeNull()
  })
  it('项目、实习、活动也按各自的名称对齐', () => {
    expect(alignNamedItem({
      section: 'project', pageItem: 1, name: '报名系统', facts: [
        fact({ group: '项目经验', item: 2, key: '项目名称', value: '报名系统' })
      ]
    })).toBe(2)
    expect(alignNamedItem({
      section: 'internship', pageItem: 1, name: '示例公司', facts: [
        fact({ group: '实习经历', item: 3, key: '企业名称', value: '示例公司' })
      ]
    })).toBe(3)
    expect(fillNamedItem({
      section: 'campus', pageItem: 1, name: '学生会', facts: [
        fact({ group: '社会实践 / 校内活动', item: 2, key: '活动名称', value: '学生会' })
      ]
    })).toBe(2)
  })
})
