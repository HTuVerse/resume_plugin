import type { FillResult, InteractionStrategyMemory } from '../../../domain/types'

export const INTERACTION_STRATEGIES_KEY = 'interactionStrategiesV1'
const MAX_ROWS = 2000

function valid(row: unknown): row is InteractionStrategyMemory {
  if (!row || typeof row !== 'object') return false
  const value = row as Partial<InteractionStrategyMemory>
  return typeof value.domain === 'string' && value.domain.length <= 300
    && (value.slot == null || typeof value.slot === 'string')
    && typeof value.controlType === 'string' && value.controlType.length <= 40
    && typeof value.strategy === 'string' && value.strategy.length <= 80
}

export async function loadInteractionStrategies(domain?: string): Promise<InteractionStrategyMemory[]> {
  const stored = await chrome.storage.local.get(INTERACTION_STRATEGIES_KEY)
  const rows = stored[INTERACTION_STRATEGIES_KEY]
  if (!Array.isArray(rows)) return []
  const validRows = rows.filter(valid).slice(-MAX_ROWS).map(row => ({
    ...row,
    hitCount: Number.isFinite(row.hitCount) ? Math.max(0, row.hitCount) : 0,
    failCount: Number.isFinite(row.failCount) ? Math.max(0, row.failCount) : 0,
    disabled: Boolean(row.disabled),
    updatedAt: row.updatedAt || ''
  }))
  return domain ? validRows.filter(row => row.domain === domain) : validRows
}

export async function saveInteractionStrategies(rows: InteractionStrategyMemory[]): Promise<void> {
  const checked = rows.filter(valid).map(row => ({
    ...row,
    hitCount: Number.isFinite(row.hitCount) ? Math.max(0, row.hitCount) : 0,
    failCount: Number.isFinite(row.failCount) ? Math.max(0, row.failCount) : 0,
    disabled: Boolean(row.disabled),
    updatedAt: row.updatedAt || ''
  }))
  const trimmed = checked.length > MAX_ROWS
    ? checked.sort((left, right) => right.hitCount - left.hitCount || right.updatedAt.localeCompare(left.updatedAt)).slice(0, MAX_ROWS)
    : checked
  await chrome.storage.local.set({ [INTERACTION_STRATEGIES_KEY]: trimmed })
}

function reliability(row: InteractionStrategyMemory): number {
  return (row.hitCount + 1) / (row.hitCount + row.failCount + 2)
}

/** 同槽位优先，否则复用本站同类控件的稳定成功策略。 */
export function preferredStrategyFor(rows: InteractionStrategyMemory[], slot: string | undefined, controlType: string): string | undefined {
  const candidates = rows.filter(row => !row.disabled && row.strategy.startsWith('trusted:')
    && row.controlType === controlType && (!row.slot || !slot || row.slot === slot))
  candidates.sort((left, right) => {
    const exact = Number(Boolean(right.slot && right.slot === slot)) - Number(Boolean(left.slot && left.slot === slot))
    return exact || reliability(right) - reliability(left) || right.hitCount - left.hitCount
  })
  const best = candidates[0]
  return best && best.hitCount > 0 && reliability(best) >= 0.5 ? best.strategy : undefined
}

export function successfulStrategy(result: FillResult): string | undefined {
  if (result.status !== 'filled') return undefined
  const rows = [...(result.trace || [])].reverse()
  return rows.find(row => row.status === 'ok' && row.strategy && (row.stage === 'visual' || row.stage === 'settle' || row.stage === 'apply'))?.strategy
}

export async function recordInteractionStrategy(
  domain: string,
  slot: string | undefined,
  controlType: string,
  strategy: string,
  succeeded: boolean
): Promise<void> {
  if (!domain || !controlType || !strategy || strategy.length > 80) return
  const rows = await loadInteractionStrategies()
  const current = rows.find(row => row.domain === domain && row.slot === slot && row.controlType === controlType && row.strategy === strategy)
  const now = new Date().toISOString()
  if (current) {
    if (succeeded) {
      current.hitCount += 1
      current.disabled = false
    } else {
      current.failCount += 1
      if (current.failCount >= 2 && current.failCount > current.hitCount) current.disabled = true
    }
    current.updatedAt = now
    await saveInteractionStrategies(rows)
    return
  }
  await saveInteractionStrategies([...rows, {
    domain,
    slot,
    controlType,
    strategy,
    hitCount: succeeded ? 1 : 0,
    failCount: succeeded ? 0 : 1,
    disabled: false,
    updatedAt: now
  }])
}

