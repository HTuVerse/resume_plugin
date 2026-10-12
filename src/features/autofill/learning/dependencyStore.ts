import type { FillRequest, FormField, LearnedFieldDependency } from '../../../domain/types'

export const FIELD_DEPENDENCIES_KEY = 'fieldDependenciesV1'
const MAX_ROWS = 3000

function valid(row: unknown): row is LearnedFieldDependency {
  if (!row || typeof row !== 'object') return false
  const value = row as Partial<LearnedFieldDependency>
  return typeof value.domain === 'string' && value.domain.length <= 300
    && typeof value.parentFingerprint === 'string' && value.parentFingerprint.length <= 300
    && typeof value.childFingerprint === 'string' && value.childFingerprint.length <= 300
    && value.parentFingerprint !== value.childFingerprint
    && value.evidence === 'option-change'
}

export async function loadFieldDependencies(domain?: string): Promise<LearnedFieldDependency[]> {
  const stored = await chrome.storage.local.get(FIELD_DEPENDENCIES_KEY)
  const rows = stored[FIELD_DEPENDENCIES_KEY]
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

export async function saveFieldDependencies(rows: LearnedFieldDependency[]): Promise<void> {
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
  await chrome.storage.local.set({ [FIELD_DEPENDENCIES_KEY]: trimmed })
}

function optionSignature(field: FormField): string {
  if (!['select', 'combobox', 'multiselect', 'cascade'].includes(field.kind)) return ''
  return `${field.kind}|${field.optionCoverage || 'unknown'}|${field.options.map(option => option.trim()).filter(Boolean).join('\u001f')}`
}

export function captureOptionStates(fields: FormField[]): Map<string, string> {
  const rows: Array<[string, string]> = []
  for (const field of fields) {
    const signature = optionSignature(field)
    if (signature) rows.push([field.fingerprint, signature])
  }
  return new Map(rows)
}

export function changedOptionFields(before: Map<string, string>, after: Map<string, string>, parentFingerprint: string): string[] {
  const hasOptions = (signature: string) => signature.split('|').slice(2).join('|').length > 0
  return [...after].filter(([fingerprint, signature]) => fingerprint !== parentFingerprint
    && before.has(fingerprint)
    && before.get(fingerprint) !== signature
    && hasOptions(signature)).map(([fingerprint]) => fingerprint)
}

export async function recordFieldDependencies(domain: string, parentFingerprint: string, childFingerprints: string[]): Promise<void> {
  const children = [...new Set(childFingerprints.filter(child => child && child !== parentFingerprint))]
  if (!domain || !parentFingerprint || !children.length) return
  const rows = await loadFieldDependencies()
  const now = new Date().toISOString()
  for (const childFingerprint of children) {
    const current = rows.find(row => row.domain === domain && row.parentFingerprint === parentFingerprint && row.childFingerprint === childFingerprint)
    if (current) {
      current.hitCount += 1
      current.disabled = false
      current.updatedAt = now
    } else {
      rows.push({ domain, parentFingerprint, childFingerprint, evidence: 'option-change', hitCount: 1, failCount: 0, disabled: false, updatedAt: now })
    }
  }
  await saveFieldDependencies(rows)
}

export async function recordDependencyOutcome(
  domain: string,
  childFingerprint: string,
  parentFingerprints: string[],
  succeeded: boolean
): Promise<void> {
  if (!domain || !childFingerprint || !parentFingerprints.length) return
  const parents = new Set(parentFingerprints)
  const rows = await loadFieldDependencies()
  const now = new Date().toISOString()
  let changed = false
  for (const row of rows) {
    if (row.domain !== domain || row.childFingerprint !== childFingerprint || !parents.has(row.parentFingerprint)) continue
    changed = true
    if (succeeded) row.hitCount += 1
    else {
      row.failCount += 1
      if (row.failCount >= 3 && row.failCount > row.hitCount) row.disabled = true
    }
    row.updatedAt = now
  }
  if (changed) await saveFieldDependencies(rows)
}

/** 只有至少观察到两次的选项变化才影响后续填写顺序。 */
export function applyLearnedDependencies(requests: FillRequest[], rows: LearnedFieldDependency[]): FillRequest[] {
  const requested = new Set(requests.map(request => request.fieldId))
  const parentsByChild = new Map<string, string[]>()
  for (const row of rows) {
    if (row.disabled || row.hitCount < 2 || !requested.has(row.parentFingerprint) || !requested.has(row.childFingerprint)) continue
    const parents = parentsByChild.get(row.childFingerprint) || []
    parents.push(row.parentFingerprint)
    parentsByChild.set(row.childFingerprint, parents)
  }
  return requests.map(request => {
    const parents = [...new Set([...(request.dependsOn || []), ...(parentsByChild.get(request.fieldId) || [])])]
    return { ...request, dependsOn: parents.length ? parents : undefined }
  })
}

