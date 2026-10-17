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
  it('PRD F04 验收：简历写「本科」、页面只有 高中/专科/学士/硕士 → 按确定性同义值归一到「学士」', () => {
    const field = makeField({ kind: 'select', options: ['高中', '专科', '学士', '硕士'] })
    const result = gateValue(slotById('education.degree'), field, '本科')
    expect(result.ok).toBe(true)
    if (result.ok) {
      // 学士 ≡ 本科 属词典内确定性同义值，直接归一，无需额外确认（前缀等弱匹配才待确认）。
      expect(result.needsConfirmation).toBe(false)
      expect(result.value).toBe('学士')
    }
  })
  it('选项集中无匹配 → no-matching-option（不猜填）', () => {
    const field = makeField({ kind: 'select', options: ['汉族', '回族'] })
    const result = gateValue(slotById('personal.ethnicity'), field, '博士')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('no-matching-option')
  })
  it('组件下拉在选项集已证明完整时和原生 select 一样拒绝对不上的值', () => {
    // 自定义下拉默认选项集不完整（虚拟列表/远程搜索），只有 complete 才在闸门处断言不存在。
    const field = makeField({ kind: 'combobox', options: ['本科', '硕士'], optionCoverage: 'complete' })
    const result = gateValue(slotById('education.degree'), field, '博士')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('no-matching-option')
  })
  it('组件下拉选项集未证明完整时放行，交给写入器展开后投影匹配', () => {
    const field = makeField({ kind: 'combobox', options: ['本科', '硕士'] })
    const result = gateValue(slotById('education.degree'), field, '博士')
    expect(result.ok).toBe(true)
  })
  it('多选在选项集完整时按选项逐个校验', () => {
    const field = makeField({ kind: 'multiselect', options: ['英语', '日语'], optionCoverage: 'complete' })
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
