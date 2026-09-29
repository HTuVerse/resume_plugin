import { describe, expect, it } from 'vitest'
import type { Fact, FormField } from '../../src/domain/types'
import { buildFactIndex, resolveField } from '../../src/features/autofill/dataResolver'

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

describe('resolveField（槽位连接 + 闸门）', () => {
  it('明确字段 + 有数据 → ready', () => {
    const index = buildFactIndex([makeFact({ key: '姓名', value: '张三' })], [])
    const field = makeField({ label: '姓名', slot: 'personal.name', slotStatus: 'resolved' })
    const resolved = resolveField(field, index)
    expect(resolved.status).toBe('ready')
    expect(resolved.value).toBe('张三')
    expect(resolved.source).toBe('profile')
  })
  it('页面已有值 → skipped（默认不覆盖，F53）', () => {
    const index = buildFactIndex([makeFact({})], [])
    const field = makeField({ slot: 'personal.name', current: '已有内容' })
    expect(resolveField(field, index).status).toBe('skipped')
  })
  it('知识库中的字段一律可填（不再预设敏感字段黑名单）', () => {
    const facts = [makeFact({ key: '证件号码', value: '110101200001011234' })]
    const index = buildFactIndex(facts, [])
    const field = makeField({ label: '证件号码', slot: 'personal.idNumber', slotStatus: 'resolved' })
    const resolved = resolveField(field, index)
    expect(resolved.status).toBe('ready')
    expect(resolved.value).toBe('110101200001011234')
  })
  it('家庭关系按称谓对齐：页面第一段是母亲时，不写入父亲', () => {
    const index = buildFactIndex([
      makeFact({ id: 'dad', group: '家庭关系', item: 1, key: '姓名', value: '张建国' }),
      makeFact({ id: 'mom', group: '家庭关系', item: 2, key: '姓名', value: '李秀兰' })
    ], [])
    const field = makeField({ label: '姓名', slot: 'family.name', item: 1, sectionId: 'family' })
    const resolved = resolveField(field, index, { segmentItem: 2 })
    expect(resolved.value).toBe('李秀兰')
    expect(resolved.factId).toBe('mom')
  })
  it('页面称谓在知识库没有对应的人时留空，避免覆盖父亲', () => {
    const index = buildFactIndex([
      makeFact({ group: '家庭关系', item: 1, key: '姓名', value: '张建国' })
    ], [])
    const field = makeField({ label: '姓名', slot: 'family.name', item: 1, sectionId: 'family' })
    expect(resolveField(field, index, { segmentItem: null }).status).toBe('empty')
  })
  it('AI 把家庭成员指到另一段时，仍按称谓对齐', () => {
    const index = buildFactIndex([
      makeFact({ id: 'dad', group: '家庭关系', item: 1, key: '姓名', value: '张建国' }),
      makeFact({ id: 'mom', group: '家庭关系', item: 2, key: '姓名', value: '李秀兰' })
    ], [])
    const field = makeField({ label: '姓名', slot: 'family.name', item: 1, sectionId: 'family' })
    const resolved = resolveField(field, index, {
      segmentItem: 2,
      aiSuggestion: { fieldId: 'f1', slot: 'family.name', factId: 'dad', confidence: 0.95, reason: '错配到父亲' }
    })
    expect(resolved.value).toBe('李秀兰')
    expect(resolved.factId).toBe('mom')
  })
  it('重复段严格按 item 对齐，档案缺该段时留空（防串段）', () => {
    const index = buildFactIndex([makeFact({ group: '教育经历', key: '学校名称', value: '第一大学', item: 1 })], [])
    const second = makeField({ label: '学校名称', slot: 'education.school', item: 2 })
    expect(resolveField(second, index).status).toBe('empty')
    const first = makeField({ label: '学校名称', slot: 'education.school', item: 1 })
    expect(resolveField(first, index).value).toBe('第一大学')
  })
  it('多个不同候选值 → needs-confirmation，不猜', () => {
    const index = buildFactIndex([
      makeFact({ group: '求职意向', key: '期望工作地点', value: '北京' }),
      makeFact({ group: '求职意向', key: '期望工作地点', value: '上海', id: 'x2' })
    ], [])
    const field = makeField({ slot: 'intention.expectedLocation' })
    const resolved = resolveField(field, index)
    expect(resolved.status).toBe('needs-confirmation')
    expect(resolved.reasonCode).toBe('multiple-candidates')
  })
  it('AI 建议槽位也走闸门（F42）：值域外 → needs-confirmation 而非填入', () => {
    const index = buildFactIndex([makeFact({ group: '基本信息', key: '政治面貌', value: '随便写的' })], [])
    const field = makeField({ label: '？？', slotStatus: 'ambiguous' })
    const resolved = resolveField(field, index, {
      aiSuggestion: { fieldId: 'f1', slot: 'personal.politicalStatus', confidence: 0.99, reason: 'AI' }
    })
    expect(resolved.status).toBe('needs-confirmation')
    expect(resolved.value).not.toBe('随便写的')
  })
  it('语义模糊且无 AI 建议 → 待用户确认（携带理由，F07）', () => {
    const index = buildFactIndex([makeFact({})], [])
    const field = makeField({ slotStatus: 'ambiguous' })
    const resolved = resolveField(field, index)
    expect(resolved.status).toBe('empty')
    expect(resolved.reasonCode).toBe('ambiguous-slot')
  })
  it('自定义字段回退：标签与自定义键名全等 → ready，自动填写', () => {
    const index = buildFactIndex([makeFact({ group: '基本信息', key: '内部推荐人工号', value: 'E12345' })], [])
    const field = makeField({ label: '内部推荐人工号', slotStatus: 'unknown' })
    const resolved = resolveField(field, index)
    expect(resolved.status).toBe('ready')
    expect(resolved.value).toBe('E12345')
  })
  it('AI 指定知识库条目：置信度达到阈值 → ready', () => {
    const fact = makeFact({ id: 'name-1', key: '名字', value: '张三' })
    const index = buildFactIndex([fact], [])
    const field = makeField({ label: '姓名', slotStatus: 'unknown' })
    const resolved = resolveField(field, index, {
      aiMatchThreshold: 85,
      aiSuggestion: { fieldId: 'f1', slot: 'personal.name', factId: 'name-1', confidence: 0.9, reason: '字段名近义' }
    })
    expect(resolved.value).toBe('张三')
    expect(resolved.factId).toBe('name-1')
    expect(resolved.status).toBe('ready')
  })
  it('AI 指定知识库条目：置信度低于阈值 → needs-confirmation', () => {
    const fact = makeFact({ id: 'name-1', key: '名字', value: '张三' })
    const index = buildFactIndex([fact], [])
    const field = makeField({ label: '姓名', slotStatus: 'unknown' })
    const resolved = resolveField(field, index, {
      aiMatchThreshold: 85,
      aiSuggestion: { fieldId: 'f1', slot: 'personal.name', factId: 'name-1', confidence: 0.5, reason: '字段名近义但不确定' }
    })
    expect(resolved.value).toBe('张三')
    expect(resolved.status).toBe('needs-confirmation')
  })
  it('AI 粒度适配：生源地「江西吉安永丰」按表单要求截取到市', () => {
    const fact = makeFact({ id: 'origin-1', group: '基本信息', key: '高考生源地', value: '江西吉安永丰' })
    const index = buildFactIndex([fact], [])
    const field = makeField({ label: '高考生源地', slot: 'personal.gaokaoOrigin', slotStatus: 'resolved' })
    const resolved = resolveField(field, index, {
      aiSuggestion: { fieldId: 'f1', slot: 'personal.gaokaoOrigin', adaptedValue: '江西吉安', confidence: 0.9, reason: '表单要求到市' }
    })
    expect(resolved.value).toBe('江西吉安')
    // 槽位由本地精确命中，AI 只适配了粒度，可以直接填写
    expect(resolved.status).toBe('ready')
  })
  it('自定义字段只做全等匹配，不做子串（R1 教训）', () => {
    const index = buildFactIndex([makeFact({ group: '基本信息', key: '工号', value: 'E12345' })], [])
    const field = makeField({ label: '内部推荐人工号', slotStatus: 'unknown' })
    expect(resolveField(field, index).status).toBe('empty')
  })
  it('学校名称对不上时，教育经历的时间留空，不填到另一段', () => {
    const index = buildFactIndex([
      makeFact({ group: '教育经历', item: 1, key: '学校名称', value: '本科大学' }),
      makeFact({ group: '教育经历', item: 1, key: '入学时间', value: '2018-09' })
    ], [])
    const field = makeField({ label: '入学时间', slot: 'education.startDate', item: 1, sectionId: 'education' })
    expect(resolveField(field, index, { segmentItem: null }).status).toBe('empty')
    expect(resolveField(field, index, { segmentItem: 1 }).value).toBe('2018-09')
  })
})
