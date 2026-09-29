import { describe, expect, it } from 'vitest'
import { matchOption } from '../../src/features/ontology/optionMatch'

describe('matchOption（§6 选项匹配策略）', () => {
  it('1. 规范化全等', () => {
    const result = matchOption(['男', '女'], '男')
    expect(result.index).toBe(0)
    expect(result.reason).toBe('exact')
  })
  it('过滤「请选择」占位项', () => {
    const result = matchOption(['请选择', '男', '女'], '女')
    expect(result.index).toBe(2)
  })
  it('2. 同义值映射：学士 → 本科', () => {
    const result = matchOption(['高中', '专科', '本科', '硕士'], '学士')
    expect(result.index).toBe(2)
    expect(result.reason).toBe('synonym')
  })
  it('2. 地名归一：北京 → 北京市', () => {
    const result = matchOption(['北京市', '上海市'], '北京')
    expect(result.index).toBe(0)
  })
  it('4. 前缀匹配且候选唯一：高中 → 高中及以下', () => {
    const result = matchOption(['初中', '高中及以下', '本科'], '高中')
    expect(result.index).toBe(1)
    expect(result.reason).toBe('prefix')
  })
  it('删除双向子串兜底：「本科」不匹配「本科以下」和「本科及以上」并存的选项集', () => {
    const result = matchOption(['本科以下', '本科及以上'], '本科')
    expect(result.index).toBe(-1)
  })
  it('多个同义匹配时标记 ambiguous，不自动选第一个', () => {
    const result = matchOption(['本科', '大学本科'], '学士')
    expect(result.ambiguous).toBe(true)
  })
  it('全不中 → -1（不猜）', () => {
    expect(matchOption(['汉族', '回族'], '博士').index).toBe(-1)
  })
})
