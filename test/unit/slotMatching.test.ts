import { describe, expect, it } from 'vitest'
import type { FormField } from '../../src/domain/types'
import { decideSlot, scoreFieldSlots } from '../../src/features/autofill/match/fieldToSlot'

/**
 * TECH_DESIGN §3.3 消歧对照组：这些是旧实现明确会错的场景，
 * 作为 slotRegistry 的单测基准。
 */

function makeField(partial: Partial<FormField>): FormField {
  return {
    id: 'f1', fingerprint: 'f1', label: '', group: '', placeholder: '', kind: 'text',
    options: [], current: '', required: false, maxLength: 0,
    ...partial
  }
}

function topSlot(field: FormField): string | undefined {
  return decideSlot(scoreFieldSlots(field), field.sectionId).slot
}

describe('§3.3 消歧对照组', () => {
  it('「最高学历」→ personal.highestDegree，不落到 education.degree', () => {
    const field = makeField({ label: '最高学历', kind: 'select', options: ['高中', '大专', '本科', '硕士', '博士'], sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.highestDegree')
  })
  it('「紧急联系人电话」→ personal.emergencyPhone，绝不落到 personal.phone', () => {
    const field = makeField({ label: '紧急联系人电话', sectionId: 'personal' })
    const scores = scoreFieldSlots(field)
    expect(scores.find(score => score.slot === 'personal.phone')).toBeUndefined() // excludePatterns 归零
    expect(topSlot(field)).toBe('personal.emergencyPhone')
  })
  it('「证明人联系方式」（实习区块）→ internship.refereePhone', () => {
    const field = makeField({ label: '证明人联系方式', group: '实习经历 第1段', sectionId: 'internship', item: 1 })
    const scores = scoreFieldSlots(field)
    expect(scores.find(score => score.slot === 'personal.phone')).toBeUndefined()
    expect(topSlot(field)).toBe('internship.refereePhone')
  })
  it('「毕业时间」在基本信息区块 → personal.graduationDate', () => {
    const field = makeField({ label: '毕业时间', sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.graduationDate')
  })
  it('「预计毕业时间」在基本信息区块 → personal.graduationDate', () => {
    const field = makeField({ label: '预计毕业时间', sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.graduationDate')
  })
  it('「毕业时间」在教育区块 → education.endDate', () => {
    const field = makeField({ label: '毕业时间', sectionId: 'education', item: 1 })
    expect(topSlot(field)).toBe('education.endDate')
  })
  it('板块未知时「毕业时间」不猜成基本信息', () => {
    const field = makeField({ label: '毕业时间' })
    expect(topSlot(field)).toBe('education.endDate')
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('resolved')
  })
  it('板块未知时「开始时间」命中多个板块，不猜', () => {
    const field = makeField({ label: '开始时间' })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('ambiguous')
  })
  it('「学位」→ education.academicDegree，与「学历」区分', () => {
    const field = makeField({ label: '学位', kind: 'select', options: ['学士', '硕士', '博士'], sectionId: 'education' })
    expect(topSlot(field)).toBe('education.academicDegree')
    const degree = makeField({ label: '学历', kind: 'select', options: ['大专', '本科', '硕士'], sectionId: 'education' })
    expect(topSlot(degree)).toBe('education.degree')
  })
})

describe('精确匹配：无精确字段名一律不自动填（留空给用户）', () => {
  it('标签为「*」即使选项集为 {男, 女} 也不猜测', () => {
    const field = makeField({ label: '*', kind: 'radio', options: ['男', '女'], labelSource: 'sibling' })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
  it('标签乱码即使选项集为学历序列也不猜测', () => {
    const field = makeField({ label: '□□□', kind: 'select', options: ['请选择', '大专', '本科', '硕士', '博士'] })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
  it('只有 name 属性没有可见标签 → 不自动填', () => {
    const field = makeField({ label: '', labelSource: 'none', attrs: { name: 'email', type: 'email' } })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
})

describe('精确字段名命中', () => {
  it('「毕业院校名称」正则命中但非别名全等 → 不自动填', () => {
    const field = makeField({ label: '毕业院校名称', sectionId: 'education', item: 1 })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
  it('别名全等（手机号 → 移动电话）→ 自动填', () => {
    const field = makeField({ label: '手机号', sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.phone')
  })
  it('学到的别名跨站点锁定槽位', () => {
    const field = makeField({ label: '名字', sectionId: 'personal' })
    const decision = decideSlot(scoreFieldSlots(field, { learnedAliases: [{ alias: '名字', slot: 'personal.name', hitCount: 1, updatedAt: '' }] }), field.sectionId)
    expect(decision.status).toBe('resolved')
    expect(decision.slot).toBe('personal.name')
  })
  it('页面是实习经历时，不把学过的「开始时间 → 项目经验」锁过来', () => {
    const field = makeField({ label: '开始时间', sectionId: 'internship' })
    const decision = decideSlot(scoreFieldSlots(field, {
      learnedAliases: [{ alias: '开始时间', slot: 'project.startDate', hitCount: 2, updatedAt: '' }]
    }), field.sectionId)
    expect(decision.slot).toBe('internship.startDate')
  })
  it('唯一命中但属于别的板块时，不采用', () => {
    const field = makeField({ label: '活动名称', sectionId: 'award' })
    expect(decideSlot(scoreFieldSlots(field), field.sectionId).status).toBe('unknown')
  })
  it('没有板块标题时，唯一命中仍可用', () => {
    const field = makeField({ label: '活动名称' })
    expect(topSlot(field)).toBe('campus.name')
  })
})

describe('决策三态', () => {
  it('完全无信号 → unknown', () => {
    const field = makeField({ label: '这是一个完全无关的字段', labelSource: 'for' })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
  it('站点规则短路锁定槽位', () => {
    const field = makeField({ label: '随便什么', fingerprint: 'fp-x' })
    const scores = scoreFieldSlots(field, {
      siteRules: [{
        id: 'r1', domain: 'a.com', fieldFingerprint: 'fp-x', slot: 'education.school',
        origin: 'user-correction', hitCount: 0, failCount: 0, disabled: false, createdAt: '', updatedAt: ''
      }]
    })
    expect(scores[0].locked).toBe(true)
    const decision = decideSlot(scores)
    expect(decision.status).toBe('resolved')
    expect(decision.slot).toBe('education.school')
  })
})
