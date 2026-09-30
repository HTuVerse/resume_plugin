import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fact } from '../../src/domain/types'
import { getCachedSuggestions, knowledgeFingerprint, putCachedSuggestions } from '../../src/features/ai/slotMatchCache'

function fact(value: string): Fact {
  return { id: 'name-1', group: '基本信息', item: 1, key: '姓名', value, evidence: '' }
}

describe('AI 字段匹配缓存', () => {
  let storage: Record<string, unknown>

  beforeEach(() => {
    storage = {}
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values) })
        }
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('知识库顺序不影响指纹，内容变化会改变指纹', () => {
    const a = fact('张三')
    const b = { ...fact('13800138000'), id: 'phone-1', key: '移动电话' }
    expect(knowledgeFingerprint([a, b])).toBe(knowledgeFingerprint([b, a]))
    expect(knowledgeFingerprint([a])).not.toBe(knowledgeFingerprint([{ ...a, value: '李四' }]))
  })

  it('知识库值变化后不复用旧 factId / adaptedValue', async () => {
    const oldFacts = [fact('江西吉安永丰')]
    await putCachedSuggestions('example.com', oldFacts, [{
      fingerprint: 'fp-1',
      suggestion: { fieldId: 'field-1', slot: 'personal.nativePlace', factId: 'name-1', adaptedValue: '江西', confidence: 0.9, reason: '截取到省' }
    }])
    expect(await getCachedSuggestions('example.com', [{ fieldId: 'field-1', fingerprint: 'fp-1' }], oldFacts)).toHaveLength(1)
    expect(await getCachedSuggestions('example.com', [{ fieldId: 'field-1', fingerprint: 'fp-1' }], [fact('北京海淀')])).toEqual([])
  })
})
