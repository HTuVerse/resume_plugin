import type {
  DiagnosticReason,
  DiagnosticStage,
  FieldDiagnosticStep,
  FillResult,
  FormField,
  ResolvedField
} from '../../../domain/types'

const STAGE_ORDER: DiagnosticStage[] = [
  'discovery', 'classification', 'semantic-match', 'fact-join',
  'value-gate', 'interaction', 'verification', 'visual'
]

function step(stage: DiagnosticStage, status: FieldDiagnosticStep['status'], options: Partial<FieldDiagnosticStep> = {}): FieldDiagnosticStep {
  return { stage, status, ...options }
}

/** 扫描完成后立即记录；这里只描述能力和结论，不复制字段标签或附近正文。 */
export function scanDiagnostics(field: FormField): FieldDiagnosticStep[] {
  const rows: FieldDiagnosticStep[] = [
    step('discovery', field.label.trim() ? 'passed' : 'warning', {
      reason: field.label.trim() ? undefined : 'unlabeled-control',
      strategy: field.labelSource || 'none'
    }),
    step('classification', field.kind ? 'passed' : 'blocked', {
      reason: field.kind ? undefined : 'unknown-control-type',
      strategy: field.kind,
      optionCoverage: field.optionCoverage
    })
  ]
  if (field.slotStatus === 'resolved' && field.slot) {
    rows.push(step('semantic-match', 'passed', { strategy: field.slotCandidates?.[0]?.locked ? 'locked-rule' : 'weighted-signals' }))
  } else {
    rows.push(step('semantic-match', 'blocked', {
      reason: field.slotStatus === 'ambiguous' ? 'ambiguous-slot' : 'unknown-slot',
      strategy: 'weighted-signals'
    }))
  }
  return rows
}

function gateReason(field: FormField, resolved: ResolvedField): DiagnosticReason | undefined {
  if (resolved.reasonCode === 'no-matching-option') {
    return field.optionCoverage === 'complete' ? 'blocked-by-complete-option-set' : 'multiple-option-candidates'
  }
  if (resolved.reasonCode === 'rejected-by-validation') return 'value-validation-rejected'
  if (resolved.reasonCode === 'value-truncated') return 'value-truncated'
  if (resolved.reasonCode === 'needs-confirmation') return 'multiple-option-candidates'
  return undefined
}

/** 将语义结论继续推进到档案连接和值域闸门。 */
export function resolutionDiagnostics(field: FormField, resolved: ResolvedField): FieldDiagnosticStep[] {
  const rows = [...(field.diagnostics || scanDiagnostics(field))]
  let semanticBlocked = rows.some(item => item.stage === 'semantic-match' && item.status === 'blocked')
  // AI 补漏或自定义字段名全等可以在扫描后补齐语义结论。
  if (semanticBlocked && (resolved.slot || resolved.factId)) {
    const index = rows.findIndex(item => item.stage === 'semantic-match')
    rows[index] = step('semantic-match', 'passed', { strategy: resolved.source === 'ai' ? 'ai-fallback' : 'custom-key-exact' })
    semanticBlocked = false
  }
  if (resolved.status === 'skipped') {
    rows.push(step('fact-join', 'skipped'), step('value-gate', 'skipped'))
    return rows
  }
  if (semanticBlocked && !resolved.factId) {
    rows.push(step('fact-join', 'skipped'), step('value-gate', 'skipped'))
    return rows
  }
  if (resolved.reasonCode === 'multiple-candidates') {
    rows.push(step('fact-join', 'warning', { reason: 'multiple-profile-candidates' }), step('value-gate', 'skipped'))
    return rows
  }
  if (!resolved.factId && resolved.source === 'empty') {
    rows.push(step('fact-join', 'blocked', { reason: 'no-profile-data' }), step('value-gate', 'skipped'))
    return rows
  }
  rows.push(step('fact-join', 'passed', { strategy: resolved.source === 'ai' ? 'ai-cited-fact' : 'slot-and-record' }))
  const reason = gateReason(field, resolved)
  if (reason) {
    rows.push(step('value-gate', resolved.value ? 'warning' : 'blocked', { reason, optionCoverage: field.optionCoverage }))
  } else if (field.optionCoverage === 'partial' || field.optionCoverage === 'unknown') {
    rows.push(step('value-gate', 'warning', {
      reason: 'partial-option-set-search-required',
      optionCoverage: field.optionCoverage,
      strategy: 'defer-to-interaction'
    }))
  } else {
    rows.push(step('value-gate', 'passed', { optionCoverage: field.optionCoverage }))
  }
  return rows
}

function executionReason(result: FillResult, stage: DiagnosticStage): DiagnosticReason | undefined {
  if (stage === 'visual' && result.reasonCode !== 'ok') return 'visual-consensus-failed'
  if (result.reasonCode === 'option-list-not-found') return 'popup-not-found'
  if (result.reasonCode === 'trusted-input-failed') return 'trusted-input-failed'
  if (result.reasonCode === 'rejected-by-validation') return 'validation-rejected'
  if (result.reasonCode === 'timeout' || result.reasonCode === 'cleared-by-rerender') return 'readback-mismatch'
  return undefined
}

/** 合并写入轨迹，用于面板详情与脱敏导出。 */
export function fullFieldDiagnostics(field: FormField, resolved?: ResolvedField, result?: FillResult): FieldDiagnosticStep[] {
  const rows = resolved?.diagnostics || (resolved ? resolutionDiagnostics(field, resolved) : field.diagnostics || scanDiagnostics(field))
  if (!result?.trace?.length) return rows
  const execution = result.trace.flatMap(item => {
    const stage: DiagnosticStage | null = item.stage === 'visual'
      ? 'visual'
      : item.stage === 'verify' || item.stage === 'settle'
        ? 'verification'
        : item.stage === 'apply' || item.stage === 'locate' || item.stage === 'precheck'
          ? 'interaction'
          : null
    if (!stage) return []
    return [step(stage, item.status === 'ok' ? 'passed' : item.status === 'skipped' ? 'skipped' : item.status === 'retry' ? 'warning' : 'blocked', {
      reason: stage === 'visual' && item.status === 'skipped' ? 'visual-not-configured' : executionReason(result, stage),
      strategy: item.strategy
    })]
  })
  const latest = new Map<DiagnosticStage, FieldDiagnosticStep>()
  for (const item of [...rows, ...execution]) latest.set(item.stage, item)
  return STAGE_ORDER.flatMap(stage => latest.has(stage) ? [latest.get(stage)!] : [])
}

export interface FunnelSummary {
  discovered: number
  classified: number
  semanticMatched: number
  gatePassed: number
  interactionStarted: number
  verified: number
}

export function summarizeFunnel(fields: FormField[], resolutions: Record<string, ResolvedField>, results: Record<string, FillResult>): FunnelSummary {
  const rows = fields.map(field => fullFieldDiagnostics(field, resolutions[field.id], results[field.id]))
  const passed = (trace: FieldDiagnosticStep[], stage: DiagnosticStage) => trace.some(item => item.stage === stage && item.status === 'passed')
  return {
    discovered: fields.length,
    classified: rows.filter(trace => passed(trace, 'classification')).length,
    semanticMatched: rows.filter(trace => passed(trace, 'semantic-match')).length,
    gatePassed: rows.filter(trace => passed(trace, 'value-gate') || trace.some(item => item.stage === 'value-gate' && item.status === 'warning')).length,
    interactionStarted: rows.filter(trace => trace.some(item => item.stage === 'interaction')).length,
    verified: rows.filter(trace => passed(trace, 'verification')).length
  }
}
