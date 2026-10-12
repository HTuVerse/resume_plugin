import type { FillResult, FormField, ResolvedField } from '../../../domain/types'
import { anonymousSiteKey } from '../learning/qualityMetrics'
import { fullFieldDiagnostics } from './trace'

function shortHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = (Math.imul(hash, 33) ^ text.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

function optionBucket(count: number): '0' | '1' | '2-5' | '6-20' | '20+' {
  if (count === 0) return '0'
  if (count === 1) return '1'
  if (count <= 5) return '2-5'
  if (count <= 20) return '6-20'
  return '20+'
}

/**
 * 生成可作为回归夹具的脱敏页面形状：不含标签、档案值、页面正文或原始指纹。
 */
export function buildRegressionFixture(
  domain: string,
  fields: FormField[],
  resolutions: Record<string, ResolvedField>,
  results: Record<string, FillResult>
) {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    siteKey: anonymousSiteKey(domain),
    controls: fields.map(field => ({
      fieldKey: shortHash(field.fingerprint),
      kind: field.kind,
      frame: field.frameId ?? 0,
      required: field.required,
      optionCount: optionBucket(field.options.length),
      optionCoverage: field.optionCoverage || 'unknown',
      hasLabel: Boolean(field.label.trim()),
      sectionKnown: Boolean(field.sectionId),
      slotStatus: field.slotStatus || 'unknown',
      resolutionStatus: resolutions[field.id]?.status,
      resultStatus: results[field.id]?.status,
      reasonCode: results[field.id]?.reasonCode || resolutions[field.id]?.reasonCode,
      pipeline: fullFieldDiagnostics(field, resolutions[field.id], results[field.id]).map(step => ({
        stage: step.stage,
        status: step.status,
        reason: step.reason,
        strategy: step.strategy,
        optionCoverage: step.optionCoverage
      }))
    }))
  }
}

