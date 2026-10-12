import type { OptionCoverage } from '../../../domain/types'
import type { UniversalControlType } from './model'

export function controlOptionCoverage(
  type: UniversalControlType,
  element: HTMLElement,
  optionCount: number,
  behaviorObserved = false
): OptionCoverage {
  if (!['single-choice', 'multi-choice', 'select', 'multi-select', 'cascade'].includes(type)) return 'unknown'
  if (type === 'single-choice' || type === 'multi-choice') return optionCount ? 'complete' : 'unknown'
  if (element instanceof HTMLSelectElement) return type === 'cascade' ? (optionCount ? 'partial' : 'unknown') : 'complete'
  if (behaviorObserved || optionCount) return 'partial'
  return 'unknown'
}

