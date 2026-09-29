import { describe, expect, it } from 'vitest'
import { parseJsonResponse } from '../../src/features/ai/responseParser'

describe('parseJsonResponse', () => {
  it('直接解析合法 JSON', () => {
    const result = parseJsonResponse('{"facts":[{"key":"姓名","value":"张三"}]}')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.facts).toHaveLength(1)
  })

  it('从 Markdown 代码围栏中提取', () => {
    const result = parseJsonResponse('好的，结果如下：\n```json\n{"ok":true}\n```')
    expect(result.ok && result.value.ok).toBe(true)
  })

  it('多个 JSON 片段时取包裹范围最大的那个', () => {
    const text = '思考：先写个草稿 {"facts":[]} 再核对原文。\n最终结果：{"facts":[{"key":"学校","value":"清华大学"}]}'
    const result = parseJsonResponse(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.facts[0].value).toBe('清华大学')
  })

  it('输出被截断时修复并保留已写完的条目', () => {
    const text = '{"facts":[{"key":"姓名","value":"张三"},{"key":"学校","value":"北京大学"},{"key":"专'
    const result = parseJsonResponse(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.facts.map((row: { value: string }) => row.value)).toEqual(['张三', '北京大学'])
  })

  it('完全无法解析时返回失败原因', () => {
    const result = parseJsonResponse('模型只返回了一段解释文字，没有任何 JSON。')
    expect(result.ok).toBe(false)
  })
})
