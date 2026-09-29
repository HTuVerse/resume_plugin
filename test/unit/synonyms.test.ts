import { describe, expect, it } from 'vitest'
import { degreeRank, expandCandidates, sameValue } from '../../src/features/ontology/synonyms'

describe('sameValue（同义值归一，F05）', () => {
  it('学历双向映射：本科 ↔ 学士', () => {
    expect(sameValue('本科', '学士')).toBe(true)
    expect(sameValue('研究生', '硕士')).toBe(true)
  })
  it('地名归一：北京 ↔ 北京市', () => {
    expect(sameValue('北京', '北京市')).toBe(true)
    expect(sameValue('广东', '广东省')).toBe(true)
  })
  it('政治面貌：党员 ↔ 中共党员', () => {
    expect(sameValue('党员', '中共党员')).toBe(true)
    expect(sameValue('团员', '共青团员')).toBe(true)
  })
  it('不同值不误判', () => {
    expect(sameValue('本科', '硕士')).toBe(false)
    expect(sameValue('北京', '南京')).toBe(false)
  })
})

describe('degreeRank（有序等级）', () => {
  it('学士与本科同级，且低于硕士', () => {
    expect(degreeRank('学士')).toBe(degreeRank('本科'))
    expect(degreeRank('本科')).toBeLessThan(degreeRank('硕士'))
    expect(degreeRank('专科')).toBe(degreeRank('大专'))
  })
  it('非学历值返回 -1', () => {
    expect(degreeRank('北京')).toBe(-1)
  })
})

describe('expandCandidates（同义候选展开，重试用）', () => {
  it('本科展开出学士', () => {
    expect(expandCandidates('本科')).toContain('学士')
  })
  it('城市展开出带后缀形式', () => {
    expect(expandCandidates('北京')).toContain('北京市')
  })
})
