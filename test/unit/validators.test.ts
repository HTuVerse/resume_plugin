import { describe, expect, it } from 'vitest'
import { normalizeDateValue, splitDateRange, validateType } from '../../src/features/ontology/validators'

describe('splitDateRange', () => {
  it('拆分「2021.9-2025.6」这类区间串', () => {
    expect(splitDateRange('2021.9-2025.6')).toEqual(['2021.9', '2025.6'])
  })
  it('不误拆「2021-09」', () => {
    expect(splitDateRange('2021-09')).toEqual(['2021-09'])
  })
  it('支持「至 / 到」分隔', () => {
    expect(splitDateRange('2021年9月至2025年6月')).toEqual(['2021年9月', '2025年6月'])
  })
})

describe('normalizeDateValue（加固版）', () => {
  it('区间串取首个日期', () => {
    expect(normalizeDateValue('2021.9-2025.6', true)).toBe('2021-09')
  })
  it('中文日期归一', () => {
    expect(normalizeDateValue('2023年5月4日', false)).toBe('2023-05-04')
  })
  it('缺日默认 01', () => {
    expect(normalizeDateValue('2023/5', false)).toBe('2023-05-01')
  })
  it('仅年份', () => {
    expect(normalizeDateValue('2024年', true)).toBe('2024-01')
  })
})

describe('validateType', () => {
  it('手机号：合法与非法', () => {
    expect(validateType('phone', '138 0013 8000').ok).toBe(true)
    expect(validateType('phone', '138 0013 8000').value).toBe('13800138000')
    expect(validateType('phone', '12345').ok).toBe(false)
  })
  it('邮箱', () => {
    expect(validateType('email', 'a@b.com').ok).toBe(true)
    expect(validateType('email', 'not-an-email').ok).toBe(false)
  })
  it('日期：非法日期被拒绝', () => {
    expect(validateType('date', '2023年13月').ok).toBe(false)
    expect(validateType('month', '2021.9-2025.6').value).toBe('2021-09')
  })
  it('布尔归一', () => {
    expect(validateType('boolean', '愿意').value).toBe('是')
    expect(validateType('boolean', '不接受').value).toBe('否')
    expect(validateType('boolean', '也许').ok).toBe(false)
  })
  it('数字提取', () => {
    expect(validateType('number', '550分').value).toBe('550')
  })
})
