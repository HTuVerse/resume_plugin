import { describe, expect, it } from 'vitest'
import { agreeOnVisualCandidate, normalizeVisualText, rankVisualCandidates, visualTextSimilarity } from '../../src/features/autofill/write/visualConsensus'

const trigger = { left: 10, top: 10, right: 210, bottom: 50 }
const candidates = [
  { id: 'ocr-1', text: '本科', confidence: 0.96, box: { left: 20, top: 65, right: 90, bottom: 95 } },
  { id: 'ocr-2', text: '硕 士', confidence: 0.91, box: { left: 20, top: 100, right: 100, bottom: 132 } }
]

describe('本地 OCR 与视觉 AI 双重确认', () => {
  it('规范化中英文空格和标点并计算相似度', () => {
    expect(normalizeVisualText(' 硕 士（研究生） ')).toBe('硕士研究生')
    expect(visualTextSimilarity('学历：硕士', '硕士')).toBeGreaterThan(0.8)
    expect(visualTextSimilarity('本科', '硕士')).toBeLessThan(0.6)
  })

  it('OCR 与 AI 选中同一候选才返回可点击坐标', () => {
    const ranked = rankVisualCandidates(candidates, ['硕士'], trigger, 'option')
    expect(ranked[0].id).toBe('ocr-2')
    expect(agreeOnVisualCandidate(ranked, { available: true, candidateId: 'ocr-2', confidence: 0.94 })).toMatchObject({ found: true, candidate: { id: 'ocr-2' } })
  })

  it('AI 与 OCR 判断不一致时拒绝点击', () => {
    const ranked = rankVisualCandidates(candidates, ['硕士'], trigger, 'option')
    const result = agreeOnVisualCandidate(ranked, { available: true, candidateId: 'ocr-1', confidence: 0.96 })
    expect(result.found).toBe(false)
    expect(result.error).toContain('不一致')
  })

  it('AI 不可用时不会退化为仅 OCR 自动点击', () => {
    const ranked = rankVisualCandidates(candidates, ['硕士'], trigger, 'option')
    expect(agreeOnVisualCandidate(ranked, { available: false, error: '未配置' })).toMatchObject({ found: false, error: '未配置' })
  })
})
