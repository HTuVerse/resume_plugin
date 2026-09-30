import { describe, expect, it } from 'vitest'
import { isLearnedDismissed, learnedDismissKey } from '../../src/features/rag/learnedDismiss'

describe('isLearnedDismissed（放弃后的页面值不再列入）', () => {
  it('同一字段、同一页面值跳过', () => {
    const dismissed = new Set([learnedDismissKey('name', '王五')])
    expect(isLearnedDismissed(dismissed, 'name', '王五')).toBe(true)
    expect(isLearnedDismissed(dismissed, 'name', ' 王五 ')).toBe(true)
  })

  it('页面值改了不再跳过', () => {
    const dismissed = new Set([learnedDismissKey('name', '王五')])
    expect(isLearnedDismissed(dismissed, 'name', '赵六')).toBe(false)
  })

  it('别的字段即使值相同也不跳过', () => {
    const dismissed = new Set([learnedDismissKey('name', '王五')])
    expect(isLearnedDismissed(dismissed, 'company', '王五')).toBe(false)
  })

  it('放弃表清空后，同一页面值恢复列入', () => {
    const dismissed = new Set([learnedDismissKey('name', '王五')])
    dismissed.clear()
    expect(isLearnedDismissed(dismissed, 'name', '王五')).toBe(false)
  })

  it('空字段或空值不算已放弃', () => {
    const dismissed = new Set([learnedDismissKey('name', '王五')])
    expect(isLearnedDismissed(dismissed, '', '王五')).toBe(false)
    expect(isLearnedDismissed(dismissed, 'name', '   ')).toBe(false)
  })
})
