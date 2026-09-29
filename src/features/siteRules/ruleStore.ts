import type { SiteRule } from '../../domain/types'
import { slotById } from '../ontology/slotRegistry'

/**
 * 站点规则库（F25/F26）：记录「字段指纹 → 槽位」，与档案数据解耦。
 * 规则可分享、不含个人信息（F27）。
 */

export const SITE_RULES_KEY = 'siteRulesV1'
const MAX_RULES = 5000

function isRule(value: unknown): value is SiteRule {
  if (!value || typeof value !== 'object') return false
  const rule = value as Partial<SiteRule>
  return typeof rule.id === 'string' && typeof rule.domain === 'string' && rule.domain.length <= 300
    && typeof rule.fieldFingerprint === 'string' && rule.fieldFingerprint.length <= 300
    && typeof rule.slot === 'string' && Boolean(slotById(rule.slot))
}

export async function loadSiteRules(): Promise<SiteRule[]> {
  const result = await chrome.storage.local.get(SITE_RULES_KEY)
  const stored = result[SITE_RULES_KEY] as unknown
  if (!Array.isArray(stored)) return []
  // 旧版本导入的规则可能缺统计字段，逐项补默认值
  return stored.filter(isRule).slice(0, MAX_RULES).map(rule => ({
    ...rule,
    hitCount: typeof rule.hitCount === 'number' ? rule.hitCount : 0,
    failCount: typeof rule.failCount === 'number' ? rule.failCount : 0,
    disabled: typeof rule.disabled === 'boolean' ? rule.disabled : false,
    origin: rule.origin || ('user-correction' as const),
    createdAt: rule.createdAt || '',
    updatedAt: rule.updatedAt || ''
  }))
}

export async function saveSiteRules(rules: SiteRule[]): Promise<void> {
  // 超限按 hitCount 升序淘汰（保留常用规则）
  const trimmed = rules.length > MAX_RULES
    ? [...rules].sort((a, b) => b.hitCount - a.hitCount).slice(0, MAX_RULES)
    : rules
  await chrome.storage.local.set({ [SITE_RULES_KEY]: trimmed })
}

/** 域名精确匹配（不做子域通配，避免规则误用到另一业务系统）。 */
export function rulesForDomain(rules: SiteRule[], domain: string): SiteRule[] {
  return rules.filter(rule => rule.domain === domain)
}

/**
 * 修正即学习（F25）：用户把某字段的匹配从 A 改为 B 时记录规则。
 * 同一指纹已有规则且槽位不同时视为再次纠正：更新槽位并累计 failCount。
 */
export async function recordCorrection(domain: string, fieldFingerprint: string, slot: string): Promise<SiteRule> {
  if (!slotById(slot)) throw new Error(`未知槽位：${slot}`)
  const rules = await loadSiteRules()
  const now = new Date().toISOString()
  const existing = rules.find(rule => rule.domain === domain && rule.fieldFingerprint === fieldFingerprint)
  if (existing) {
    if (existing.slot !== slot) {
      existing.failCount += 1
      existing.slot = slot
      existing.disabled = false
    }
    existing.updatedAt = now
    await saveSiteRules(rules)
    return existing
  }
  const rule: SiteRule = {
    id: crypto.randomUUID(), domain, fieldFingerprint, slot,
    origin: 'user-correction', hitCount: 0, failCount: 0, disabled: false,
    createdAt: now, updatedAt: now
  }
  await saveSiteRules([...rules, rule])
  return rule
}

export async function recordHit(ruleId: string): Promise<void> {
  const rules = await loadSiteRules()
  const rule = rules.find(item => item.id === ruleId)
  if (!rule) return
  rule.hitCount += 1
  rule.updatedAt = new Date().toISOString()
  await saveSiteRules(rules)
}

/**
 * 规则命中后写入仍失败时降权（§12.2）。
 * failCount ≥ 3 且 failCount > hitCount 时自动停用（站点改版自愈）。
 */
export async function recordFailure(ruleId: string): Promise<void> {
  const rules = await loadSiteRules()
  const rule = rules.find(item => item.id === ruleId)
  if (!rule) return
  rule.failCount += 1
  if (rule.failCount >= 3 && rule.failCount > rule.hitCount) rule.disabled = true
  rule.updatedAt = new Date().toISOString()
  await saveSiteRules(rules)
}

export async function setRuleDisabled(ruleId: string, disabled: boolean): Promise<void> {
  const rules = await loadSiteRules()
  const rule = rules.find(item => item.id === ruleId)
  if (!rule) return
  rule.disabled = disabled
  rule.updatedAt = new Date().toISOString()
  await saveSiteRules(rules)
}

export async function removeRule(ruleId: string): Promise<void> {
  const rules = await loadSiteRules()
  await saveSiteRules(rules.filter(rule => rule.id !== ruleId))
}

export async function clearSiteRules(): Promise<void> {
  await chrome.storage.local.remove(SITE_RULES_KEY)
}

/** 规则包导入（F27）：结构校验，不含个人数据。 */
export async function importRules(payload: unknown): Promise<number> {
  if (!Array.isArray(payload)) throw new Error('规则包格式无效：应为规则数组。')
  const incoming = payload.filter(isRule).map(rule => ({ ...rule, origin: 'imported' as const }))
  if (!incoming.length) throw new Error('规则包中没有有效规则。')
  const rules = await loadSiteRules()
  const seen = new Set(rules.map(rule => `${rule.domain}|${rule.fieldFingerprint}`))
  const fresh = incoming.filter(rule => !seen.has(`${rule.domain}|${rule.fieldFingerprint}`))
  await saveSiteRules([...rules, ...fresh])
  return fresh.length
}
