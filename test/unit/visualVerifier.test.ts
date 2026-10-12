import { describe, expect, it } from 'vitest'
import { parseVisualDecision } from '../../src/features/ai/visualVerifier'

describe('视觉 AI 响应闸门', () => {
  it('只接受 OCR 候选集合中的编号', () => {
    expect(parseVisualDecision('{"candidateId":"ocr-2","confidence":0.91}', new Set(['ocr-1', 'ocr-2']))).toMatchObject({
      available: true,
      candidateId: 'ocr-2',
      confidence: 0.91
    })
    expect(parseVisualDecision('{"candidateId":"invented","confidence":0.99}', new Set(['ocr-1']))).toMatchObject({
      available: true,
      error: '视觉 AI 未选择有效的 OCR 候选'
    })
  })
})
