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
  it('没有板块时，男/女只对上性别，并且和第二名拉开差距，仍然解析', () => {
    const field = makeField({ label: '*', kind: 'radio', options: ['男', '女'], labelSource: 'sibling' })
    const decision = decideSlot(scoreFieldSlots(field))
    expect(decision.status).toBe('resolved')
    expect(decision.slot).toBe('personal.gender')
  })
  it('标签乱码即使选项集为学历序列也不猜测', () => {
    const field = makeField({ label: '□□□', kind: 'select', options: ['请选择', '大专', '本科', '硕士', '博士'] })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
  it('只有 name=email、没有可见标签 → 唯一属性命中邮箱', () => {
    const field = makeField({ label: '', labelSource: 'none', attrs: { name: 'email', type: 'email' } })
    expect(topSlot(field)).toBe('personal.email')
  })
  it('name=company 且板块未知时，工作和实习都对得上，不猜', () => {
    const field = makeField({ label: '', labelSource: 'none', attrs: { name: 'company' } })
    expect(decideSlot(scoreFieldSlots(field)).status).toBe('unknown')
  })
  it('工作板块里的 name=company → 工作单位', () => {
    const field = makeField({ label: '', labelSource: 'none', attrs: { name: 'company' }, sectionId: 'work' })
    expect(topSlot(field)).toBe('work.company')
  })
})

describe('精确字段名命中', () => {
  it('「毕业院校名称」在教育板块正则唯一命中 → 自动填', () => {
    const field = makeField({ label: '毕业院校名称', sectionId: 'education', item: 1 })
    expect(topSlot(field)).toBe('education.school')
  })
  it('板块里选项是男/女，标签不是别名时仍能反推性别', () => {
    const field = makeField({ label: '请选择', kind: 'radio', options: ['男', '女'], sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.gender')
  })
  it('兄弟节点上的别名全等仍自动填', () => {
    const field = makeField({ label: '手机号', labelSource: 'sibling', sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.phone')
  })
  it('字段名来自 placeholder 且与别名全等 → 自动填', () => {
    const field = makeField({ label: '性别', labelSource: 'placeholder', placeholder: '请选择性别', sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.gender')
  })
  it('别名全等（手机号 → 移动电话）→ 自动填', () => {
    const field = makeField({ label: '手机号', sectionId: 'personal' })
    expect(topSlot(field)).toBe('personal.phone')
  })
  it('工作经历里的公司名称落到工作板块，不落到实习', () => {
    expect(topSlot(makeField({ label: '公司名称', sectionId: 'work' }))).toBe('work.company')
    expect(topSlot(makeField({ label: '公司名称', sectionId: 'internship' }))).toBe('internship.company')
  })
  it('学到的别名跨站点锁定槽位', () => {
    const field = makeField({ label: '名字', sectionId: 'personal' })
    const decision = decideSlot(scoreFieldSlots(field, { learnedAliases: [{ alias: '名字', slot: 'personal.name', hitCount: 1, updatedAt: '' }] }), field.sectionId)
    expect(decision.status).toBe('resolved')
    expect(decision.slot).toBe('personal.name')
  })
  it('别名忽略标点和停用状态', () => {
    const punctuated = makeField({ label: '姓名：', sectionId: 'personal' })
    const decision = decideSlot(scoreFieldSlots(punctuated, {
      learnedAliases: [{ alias: '姓名', slot: 'personal.phone', hitCount: 1, updatedAt: '' }]
    }), punctuated.sectionId)
    expect(decision.slot).toBe('personal.phone')
    const disabled = decideSlot(scoreFieldSlots(punctuated, {
      learnedAliases: [{ alias: '姓名', slot: 'personal.phone', hitCount: 1, failCount: 4, disabled: true, updatedAt: '' }]
    }), punctuated.sectionId)
    expect(disabled.slot).toBe('personal.name')
  })
  it('板块未知时，不把学过的「开始时间」锁到某一个板块', () => {
    const field = makeField({ label: '开始时间' })
    const decision = decideSlot(scoreFieldSlots(field, {
      learnedAliases: [{ alias: '开始时间', slot: 'project.startDate', hitCount: 2, updatedAt: '' }]
    }), field.sectionId)
    expect(decision.status).toBe('ambiguous')
    expect(decision.slot).toBeUndefined()
  })
  it('学到的「开始时间」带上教育板块后，只锁教育经历', () => {
    const education = makeField({ label: '开始时间', sectionId: 'education' })
    const project = makeField({ label: '开始时间', sectionId: 'project' })
    const aliases = [{ alias: '开始时间', slot: 'education.startDate', sectionId: 'education', hitCount: 1, updatedAt: '' }]
    expect(decideSlot(scoreFieldSlots(education, { learnedAliases: aliases }), education.sectionId).slot).toBe('education.startDate')
    expect(decideSlot(scoreFieldSlots(project, { learnedAliases: aliases }), project.sectionId).slot).toBe('project.startDate')
  })
  it('同一板块里，短别名可以盖住多出来的几个字', () => {
    const field = makeField({ label: '就读院校全称', sectionId: 'education' })
    expect(decideSlot(scoreFieldSlots(field), field.sectionId).status).toBe('unknown')
    const decision = decideSlot(scoreFieldSlots(field, {
      learnedAliases: [{ alias: '就读院校', slot: 'education.school', sectionId: 'education', hitCount: 1, updatedAt: '' }]
    }), field.sectionId)
    expect(decision.slot).toBe('education.school')
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
  it('同站相同标签、指纹不同时，仍按用户确认过的槽位', () => {
    const field = makeField({ label: '院校全称', fingerprint: 'fp-other', sectionId: 'education' })
    const decision = decideSlot(scoreFieldSlots(field, {
      siteRules: [{
        id: 'r2', domain: 'a.com', fieldFingerprint: 'fp-x', labelKey: '院校全称', sectionId: 'education', slot: 'education.school',
        origin: 'user-correction', hitCount: 1, failCount: 0, disabled: false, createdAt: '', updatedAt: ''
      }]
    }), field.sectionId)
    expect(decision.status).toBe('resolved')
    expect(decision.slot).toBe('education.school')
  })
})
