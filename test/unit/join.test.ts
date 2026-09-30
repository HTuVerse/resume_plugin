import { describe, expect, it } from 'vitest'
import type { FormField } from '../../src/domain/types'
import { gateValue } from '../../src/features/autofill/match/join'
import { slotById } from '../../src/features/ontology/slotRegistry'

function makeField(partial: Partial<FormField>): FormField {
  return {
    id: 'f1', fingerprint: 'f1', label: '', group: '', placeholder: '', kind: 'text',
    options: [], current: '', required: false, maxLength: 0,
    ...partial
  }
}

describe('gateValue（F04 硬闸门）', () => {
  it('类型不合法 → rejected-by-validation', () => {
    const result = gateValue(slotById('personal.phone'), makeField({}), '不是手机号')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('rejected-by-validation')
  })
  it('PRD F04 验收：简历写「本科」、页面只有 高中/专科/学士/硕士 → 给出「学士」待确认候选，而非直接填入或静默丢弃', () => {
    const field = makeField({ kind: 'select', options: ['高中', '专科', '学士', '硕士'] })
    const result = gateValue(slotById('education.degree'), field, '本科')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.needsConfirmation).toBe(true)
      expect(result.value).toBe('学士')
    }
  })
  it('选项集中无匹配 → no-matching-option（不猜填）', () => {
    const field = makeField({ kind: 'select', options: ['汉族', '回族'] })
    const result = gateValue(slotById('personal.ethnicity'), field, '博士')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('no-matching-option')
  })
  it('组件下拉有选项集时和原生 select 一样拒绝对不上的值', () => {
    const field = makeField({ kind: 'combobox', options: ['本科', '硕士'] })
    const result = gateValue(slotById('education.degree'), field, '博士')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('no-matching-option')
  })
  it('多选按选项逐个校验', () => {
    const field = makeField({ kind: 'multiselect', options: ['英语', '日语'] })
    const result = gateValue(undefined, field, '英语、韩语')
    expect(result.ok).toBe(false)
  })
  it('选择类控件静态读不到选项时交给写入器动态展开并唯一匹配', () => {
    const empty = gateValue(slotById('personal.gender'), makeField({ kind: 'combobox', options: [] }), '男')
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.needsConfirmation).toBe(false)
    const placeholder = gateValue(slotById('education.degree'), makeField({ kind: 'select', options: ['请选择'] }), '本科')
    expect(placeholder.ok).toBe(true)
    if (placeholder.ok) expect(placeholder.needsConfirmation).toBe(false)
  })
  it('全等命中直接通过，不需确认', () => {
    const field = makeField({ kind: 'radio', options: ['男', '女'] })
    const result = gateValue(slotById('personal.gender'), field, '男')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.needsConfirmation).toBe(false)
  })
  it('超长 → 截断并待确认，不静默失败', () => {
    const field = makeField({ maxLength: 5 })
    const result = gateValue(slotById('summary.content'), field, '这是一段很长很长的自我评价')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.needsConfirmation).toBe(true)
      expect(result.value.length).toBe(5)
    }
  })
  it('日期归一化后写入', () => {
    const result = gateValue(slotById('personal.birthday'), makeField({ kind: 'date' }), '2000年3月5日')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('2000-03-05')
  })
  it('枚举值域校验：AI 给出值域外的值 → 拒绝（F42 验收）', () => {
    const result = gateValue(slotById('personal.politicalStatus'), makeField({}), '不存在的面貌')
    expect(result.ok).toBe(false)
  })
})
