import { SLOTS, aliasHit } from '../../features/ontology/slotRegistry'

/**
 * 隐私脱敏。敏感判定优先按槽位查询（SlotDef.sensitive 为单一数据源），
 * SENSITIVE_PATTERN 仅作兜底（覆盖不在槽位表内的键名，如密码 / token）。
 */

const SENSITIVE_PATTERN = /姓名|手机|电话|邮箱|email|phone|密码|口令|身份证|证件号|银行卡|银行账号|社保|公积金|地址|生日|token|secret|password|api\s*key|access\s*key/i

export function isSensitiveField(key: string): boolean {
  const trimmed = String(key || '').trim()
  if (!trimmed) return false
  // 槽位查询：键名对应到敏感槽位（证件号码、紧急联系人、证明人、家庭成员等）
  const slotHits = SLOTS.filter(slot => aliasHit(slot, trimmed) || slot.patterns?.some(pattern => pattern.test(trimmed)))
  if (slotHits.some(slot => slot.sensitive)) return true
  // 兜底正则（备份脱敏语义比 F54 自动填写语义更宽：姓名 / 电话等也要遮蔽）
  return SENSITIVE_PATTERN.test(trimmed)
}

export function maskValue(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(8, Math.max(4, value.length - 4)))}${value.slice(-2)}`
}

export function maskApiUrl(value: string): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    return `${url.origin}/…`
  } catch {
    return '已配置（地址已脱敏）'
  }
}

export function isRedacted(value: string): boolean {
  return value === '••••••••' || value === '[已脱敏]' || value === '[REDACTED]' || value.includes('•')
}

/**
 * Redact a fact without mutating the object held by the editor.
 * Evidence is removed as well because a source excerpt can contain the same
 * personal information as the value itself.
 */
export function redactFact<T extends { key: string; value: string; evidence?: string; sensitive?: boolean }>(fact: T): T {
  if (!fact.sensitive && !isSensitiveField(fact.key)) return { ...fact }
  return { ...fact, value: maskValue(fact.value), evidence: fact.evidence ? '[已脱敏]' : fact.evidence }
}

export function redactFacts<T extends { key: string; value: string; evidence?: string; sensitive?: boolean }>(facts: T[]): T[] {
  return facts.map(redactFact)
}
