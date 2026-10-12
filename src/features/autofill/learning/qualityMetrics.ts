import type { FillResult } from '../../../domain/types'

export const AUTOFILL_QUALITY_KEY = 'autofillQualityV1'
const MAX_ROWS = 600

export interface AutofillQualityMetric {
  day: string
  siteKey: string
  controlType: string
  strategy: string
  stage: string
  reasonCode: string
  attempts: number
  total: number
  filled: number
  failed: number
  elapsedMs: number
}

export function anonymousSiteKey(domain: string): string {
  let hash = 2166136261
  for (let index = 0; index < domain.length; index += 1) {
    hash ^= domain.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `site-${(hash >>> 0).toString(36)}`
}

function valid(row: unknown): row is AutofillQualityMetric {
  if (!row || typeof row !== 'object') return false
  const value = row as Partial<AutofillQualityMetric>
  return typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.day)
    && typeof value.siteKey === 'string' && value.siteKey.startsWith('site-')
    && typeof value.controlType === 'string' && typeof value.strategy === 'string'
    && typeof value.stage === 'string' && typeof value.reasonCode === 'string'
}

export async function loadQualityMetrics(): Promise<AutofillQualityMetric[]> {
  const stored = await chrome.storage.local.get(AUTOFILL_QUALITY_KEY)
  const rows = stored[AUTOFILL_QUALITY_KEY]
  return Array.isArray(rows) ? rows.filter(valid).slice(-MAX_ROWS).map(row => ({
    ...row,
    attempts: Number.isFinite(row.attempts) ? Math.max(0, row.attempts) : 0,
    total: Number.isFinite(row.total) ? Math.max(0, row.total) : 0,
    filled: Number.isFinite(row.filled) ? Math.max(0, row.filled) : 0,
    failed: Number.isFinite(row.failed) ? Math.max(0, row.failed) : 0,
    elapsedMs: Number.isFinite(row.elapsedMs) ? Math.max(0, row.elapsedMs) : 0
  })) : []
}

function strategyOf(result: FillResult): string {
  const traced = [...(result.trace || [])].reverse().find(row => row.strategy && (row.stage === 'visual' || row.stage === 'settle' || row.stage === 'apply'))
  return traced?.strategy || 'none'
}

function stageOf(result: FillResult): string {
  const rows = [...(result.trace || [])].reverse()
  return rows.find(row => row.status === 'failed' || row.status === 'skipped')?.stage
    || rows.find(row => row.status === 'ok')?.stage
    || 'unknown'
}

export async function recordQualityResult(domain: string, controlType: string, result: FillResult): Promise<void> {
  if (!domain || !controlType) return
  const rows = await loadQualityMetrics()
  const day = new Date().toISOString().slice(0, 10)
  const siteKey = anonymousSiteKey(domain)
  const strategy = strategyOf(result)
  const stage = stageOf(result)
  const reasonCode = result.reasonCode || result.status
  const current = rows.find(row => row.day === day && row.siteKey === siteKey && row.controlType === controlType
    && row.strategy === strategy && row.stage === stage && row.reasonCode === reasonCode)
  if (current) {
    current.total += 1
    current.filled += Number(result.status === 'filled')
    current.failed += Number(result.status === 'failed')
    current.attempts += result.attempts || 0
    current.elapsedMs += result.elapsedMs || 0
  } else {
    rows.push({
      day, siteKey, controlType, strategy, stage, reasonCode,
      attempts: result.attempts || 0,
      total: 1,
      filled: Number(result.status === 'filled'),
      failed: Number(result.status === 'failed'),
      elapsedMs: result.elapsedMs || 0
    })
  }
  await chrome.storage.local.set({ [AUTOFILL_QUALITY_KEY]: rows.slice(-MAX_ROWS) })
}

