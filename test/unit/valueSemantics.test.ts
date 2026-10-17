import { describe, expect, it } from 'vitest'
import { slotById } from '../../src/features/ontology/slotRegistry'
import { compareSemanticValues, semanticValuesMatch } from '../../src/features/ontology/valueSemantics'

describe('槽位感知值语义', () => {
  it('同一日期的不同展示格式视为相同', () => {
    const slot = slotById('personal.birthday')
    expect(compareSemanticValues('1971-06-07', '1971-6-7', { slot })).toBe('equal')
  })

  it('低精度页面值兼容完整日期但不应覆盖，高精度新值属于补充', () => {
    const slot = slotById('personal.birthday')
    expect(compareSemanticValues('1971-06-07', '1971-6', { slot })).toBe('compatible')
    expect(compareSemanticValues('1971-06', '1971-6-7', { slot })).toBe('enrichment')
  })

  it('槽位私有值别名由统一比较器处理', () => {
    const slot = slotById('family.relation')
    expect(semanticValuesMatch('父亲', '爸爸', { slot })).toBe(true)
    expect(semanticValuesMatch('母亲', '妈妈', { slot })).toBe(true)
    expect(semanticValuesMatch('父亲', '母亲', { slot })).toBe(false)
  })

  it('电话、数值和多选使用各自的规范形式', () => {
    expect(semanticValuesMatch('13800138000', '138 0013 8000', { slot: slotById('personal.phone') })).toBe(true)
    expect(semanticValuesMatch('550', '550分', { slot: slotById('skill.englishScore') })).toBe(true)
    expect(semanticValuesMatch('英语、日语', '日语,英语', { field: { kind: 'multiselect' } })).toBe(true)
  })

  it('级联投影命中与知识原值视为一致，避免投影填写后被当作修正重复入库', () => {
    expect(semanticValuesMatch('江西省吉安市永丰县', '江西 / 吉安 / 永丰', { field: { kind: 'cascade' } })).toBe(true)
  })

  it('下拉/组合框选项同义等价视为一致', () => {
    expect(semanticValuesMatch('本科', '学士', { field: { kind: 'select' } })).toBe(true)
    expect(semanticValuesMatch('本科', '硕士', { field: { kind: 'select' } })).toBe(false)
    expect(semanticValuesMatch('北京', '北京市', { field: { kind: 'combobox' } })).toBe(true)
  })
})
