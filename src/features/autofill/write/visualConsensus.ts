export interface VisualBox {
  left: number
  top: number
  right: number
  bottom: number
}

export interface OcrCandidate {
  id: string
  text: string
  confidence: number
  box: VisualBox
}

export interface RankedVisualCandidate extends OcrCandidate {
  target: string
  textConfidence: number
  score: number
}

export interface AiVisualDecision {
  available: boolean
  candidateId?: string
  confidence?: number
  reason?: string
  error?: string
}

export interface VisualConsensus {
  found: boolean
  confidence: number
  candidate?: RankedVisualCandidate
  error?: string
}

export function normalizeVisualText(value: string): string {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function editDistance(left: string, right: string): number {
  if (!left.length) return right.length
  if (!right.length) return left.length
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      )
      diagonal = above
    }
  }
  return previous[right.length]
}

export function visualTextSimilarity(observed: string, target: string): number {
  const left = normalizeVisualText(observed)
  const right = normalizeVisualText(target)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length)
    return 0.72 + 0.26 * ratio
  }
  return Math.max(0, 1 - editDistance(left, right) / Math.max(left.length, right.length))
}

function center(box: VisualBox): { x: number; y: number } {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
}

function inside(box: VisualBox, point: { x: number; y: number }): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
}

export function rankVisualCandidates(
  candidates: OcrCandidate[],
  targets: string[],
  trigger: VisualBox,
  mode: 'option' | 'verify'
): RankedVisualCandidate[] {
  const triggerCenter = center(trigger)
  const ranked: RankedVisualCandidate[] = []
  for (const candidate of candidates) {
    const candidateCenter = center(candidate.box)
    if (mode === 'option' && inside(trigger, candidateCenter)) continue
    const width = candidate.box.right - candidate.box.left
    const height = candidate.box.bottom - candidate.box.top
    if (width < 2 || height < 4 || height > 100) continue
    for (const target of targets) {
      const textConfidence = visualTextSimilarity(candidate.text, target)
      if (textConfidence < 0.48) continue
      const distance = Math.hypot(candidateCenter.x - triggerCenter.x, candidateCenter.y - triggerCenter.y)
      const geometry = Math.max(0, 1 - distance / 700)
      const score = textConfidence * 0.76 + Math.max(0, Math.min(1, candidate.confidence)) * 0.16 + geometry * 0.08
      ranked.push({ ...candidate, target, textConfidence, score })
    }
  }
  return ranked.sort((left, right) => right.score - left.score || right.textConfidence - left.textConfidence || right.confidence - left.confidence)
}

/** OCR 与视觉 AI 必须独立选中同一候选，任何分歧都不会产生坐标点击。 */
export function agreeOnVisualCandidate(ranked: RankedVisualCandidate[], ai: AiVisualDecision): VisualConsensus {
  const local = ranked[0]
  if (!local || local.score < 0.62) return { found: false, confidence: local?.score || 0, error: '本地 OCR 未找到高置信目标文字' }
  if (!ai.available) return { found: false, confidence: local.score, error: ai.error || '视觉 AI 未配置或不可用' }
  const aiConfidence = Math.max(0, Math.min(1, Number(ai.confidence) || 0))
  if (!ai.candidateId || ai.candidateId !== local.id) {
    return { found: false, confidence: Math.min(local.score, aiConfidence), error: '本地 OCR 与视觉 AI 对目标位置判断不一致' }
  }
  if (aiConfidence < 0.65) return { found: false, confidence: aiConfidence, error: '视觉 AI 复核置信度不足' }
  return { found: true, confidence: Math.min(local.score, aiConfidence), candidate: local }
}
