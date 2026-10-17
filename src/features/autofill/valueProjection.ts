import { normalize } from '../../shared/normalize'
import { isPlaceholderOption, matchOption, plainChoiceText } from '../ontology/optionMatch'
import { expandCandidates } from '../ontology/synonyms'

export interface ProjectedOption {
  index: number
  value: string
  ambiguous: boolean
  reason: 'direct' | 'projection'
}

function forms(value: string): string[] {
  return [...new Set([value, ...expandCandidates(value)].map(normalize).filter(Boolean))]
}

/**
 * 用控件此刻真正可选的值约束知识原值。返回最高分候选，
 * 并列时稳定选择首个且标记 ambiguous，供写入结果用提示色标注。
 */
export function projectOptionFromValue(options: string[], rawValue: string, excluded: string[] = []): ProjectedOption | null {
  const direct = matchOption(options, rawValue)
  if (direct.index >= 0) {
    return {
      index: direct.index,
      value: plainChoiceText(options[direct.index]),
      ambiguous: Boolean(direct.ambiguous),
      reason: 'direct'
    }
  }

  const raw = normalize(rawValue)
  if (!raw) return null
  const blocked = new Set(excluded.map(normalize).filter(Boolean))
  const candidates = options.flatMap((option, index) => {
    const value = plainChoiceText(option)
    if (!value || isPlaceholderOption(value) || blocked.has(normalize(value))) return []
    const spans = forms(value).filter(form => form.length >= 2 && raw.includes(form))
    if (!spans.length) return []
    const longest = Math.max(...spans.map(span => span.length))
    return [{ index, value, score: longest / raw.length, spanLength: longest }]
  }).sort((left, right) => right.score - left.score || right.spanLength - left.spanLength)

  if (!candidates.length) return null
  const best = candidates[0]
  const tied = candidates.filter(candidate => candidate.score === best.score && candidate.spanLength === best.spanLength)
  return {
    index: best.index,
    value: best.value,
    ambiguous: tied.length > 1,
    reason: 'projection'
  }
}

function sequenceParts(value: string): string[] {
  const parts = String(value || '').split(/\s*[/|>»→、,，]\s*/).map(item => item.trim()).filter(Boolean)
  return parts.length > 1 ? parts : [String(value || '').trim()].filter(Boolean)
}

function orderedCoverage(parts: string[], target: string): number {
  const targetNorm = normalize(target)
  if (!targetNorm || !parts.length) return 0
  let cursor = 0
  let covered = 0
  for (const part of parts) {
    const variants = forms(part).sort((left, right) => right.length - left.length)
    let found: { index: number; length: number } | null = null
    for (const variant of variants) {
      if (variant.length < 2) continue
      const index = targetNorm.indexOf(variant, cursor)
      if (index >= 0 && (!found || variant.length > found.length)) found = { index, length: variant.length }
    }
    if (!found) return 0
    cursor = found.index + found.length
    covered += found.length
  }
  return covered / targetNorm.length
}

/** 通用有序复合值比较：局部有序投影不能覆盖更完整的原值。 */
export function compareProjectedSequence(existing: string, observed: string): 'equal' | 'compatible' | 'enrichment' | 'different' {
  if (normalize(existing) === normalize(observed)) return 'equal'
  const observedParts = sequenceParts(observed)
  const existingParts = sequenceParts(existing)
  const observedInExisting = observedParts.length > 1 ? orderedCoverage(observedParts, existing) : 0
  if (observedInExisting >= 0.6) return 'compatible'
  const existingInObserved = existingParts.length > 1 ? orderedCoverage(existingParts, observed) : 0
  if (existingInObserved >= 0.6) return 'enrichment'
  return 'different'
}
