import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fact, FormField } from '../../src/domain/types'
import { OpenAICompatibleProvider } from '../../src/features/ai/openaiCompatibleProvider'

function field(): FormField {
  return {
    id: 'field-1', fingerprint: 'fp-1', label: '亲属任职岗位', group: '家庭关系', sectionId: 'family',
    placeholder: '请输入亲属职位', kind: 'text', options: [], current: '', required: true, maxLength: 0, item: 1
  }
}

function fact(): Fact {
  return { id: 'custom-1', group: '家庭关系', item: 1, key: '亲属职位', value: '工程师', evidence: '', source: 'profile' }
}

afterEach(() => vi.unstubAllGlobals())

describe('AI 二级字段匹配', () => {
  it('允许用真实 factId 匹配字段本体之外的知识库字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          matches: [{ fieldId: 'field-1', factId: 'custom-1', confidence: 0.96, reason: '字段含义一致' }]
        }) } }]
      })
    })))
    const provider = new OpenAICompatibleProvider({ url: 'https://example.com', key: 'test', model: 'test-model' })
    const result = await provider.matchFields([field()], [fact()])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.suggestions).toEqual([{
      fieldId: 'field-1', slot: undefined, factId: 'custom-1', adaptedValue: undefined,
      confidence: 0.96, reason: '字段含义一致'
    }])
  })

  it('丢弃 AI 编造的 factId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"matches":[{"fieldId":"field-1","factId":"invented","confidence":1}]}' } }]
      })
    })))
    const provider = new OpenAICompatibleProvider({ url: 'https://example.com', key: 'test', model: 'test-model' })
    const result = await provider.matchFields([field()], [fact()])
    expect(result.ok && result.data.suggestions).toEqual([])
  })

  it('丢弃不属于本次请求的字段 ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"matches":[{"fieldId":"invented-field","factId":"custom-1","confidence":1}]}' } }]
      })
    })))
    const provider = new OpenAICompatibleProvider({ url: 'https://example.com', key: 'test', model: 'test-model' })
    const result = await provider.matchFields([field()], [fact()])
    expect(result.ok && result.data.suggestions).toEqual([])
  })

  it('丢弃与本地页面槽位冲突的 AI 槽位', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"matches":[{"fieldId":"field-1","slot":"personal.phone","confidence":1}]}' } }]
      })
    })))
    const provider = new OpenAICompatibleProvider({ url: 'https://example.com', key: 'test', model: 'test-model' })
    const local = { ...field(), slot: 'family.employer', slotStatus: 'resolved' as const }
    const result = await provider.matchFields([local], [fact()])
    expect(result.ok && result.data.suggestions).toEqual([])
  })

  it('丢弃与已知知识条目语义冲突的 AI 槽位', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"matches":[{"fieldId":"field-1","slot":"personal.name","factId":"phone-1","confidence":1}]}' } }]
      })
    })))
    const phone = { ...fact(), id: 'phone-1', group: '基本信息', key: '移动电话', value: '13800138000' }
    const provider = new OpenAICompatibleProvider({ url: 'https://example.com', key: 'test', model: 'test-model' })
    const result = await provider.matchFields([field()], [phone])
    expect(result.ok && result.data.suggestions).toEqual([])
  })
})
