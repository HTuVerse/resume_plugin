import type { Fact, SlotSuggestion } from '../../domain/types'
import { shortHash } from '../autofill/scan/fingerprint'
import { SLOT_REGISTRY_VERSION, slotById } from '../ontology/slotRegistry'

/**
 * AI 槽位匹配缓存（F43）。
 * 缓存键 = hash(domain + 字段指纹 + 知识库指纹 + slotRegistryVersion)。
 * AI 结果可能带 factId / adaptedValue，知识库变化时必须失效；词典升级也会失效。
 */

export const AI_SLOT_CACHE_KEY = 'aiSlotCacheV1'
const MAX_ENTRIES = 2000

interface CacheEntry {
  slot?: string
  confidence: number
  reason: string
  /** AI 指定的知识库条目。读取时若档案里已没有该条目，则丢掉 factId。 */
  factId?: string
  /** 按表单粒度截取的值（原值的连续子串）。 */
  adaptedValue?: string
  at: number
  domain?: string
  fingerprint?: string
}

export function knowledgeFingerprint(facts: ReadonlyArray<Pick<Fact, 'id' | 'group' | 'item' | 'key' | 'value'>>): string {
  const material = facts
    .map(({ id, group, item, key, value }) => [id, group, Math.max(1, item || 1), key, value] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
  return shortHash(JSON.stringify(material))
}

function cacheKey(domain: string, fingerprint: string, factsHash: string): string {
  return shortHash(`${domain}|${fingerprint}|${factsHash}|${SLOT_REGISTRY_VERSION}`)
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
  const result = await chrome.storage.local.get(AI_SLOT_CACHE_KEY)
  const stored = result[AI_SLOT_CACHE_KEY]
  return stored && typeof stored === 'object' ? stored as Record<string, CacheEntry> : {}
}

export async function getCachedSuggestions(
  domain: string,
  fingerprints: Array<{ fieldId: string; fingerprint: string }>,
  facts: Fact[]
): Promise<SlotSuggestion[]> {
  const cache = await loadCache()
  const factsHash = knowledgeFingerprint(facts)
  const factsById = new Map(facts.map(fact => [fact.id, fact]))
  const out: SlotSuggestion[] = []
  for (const { fieldId, fingerprint } of fingerprints) {
    const entry = cache[cacheKey(domain, fingerprint, factsHash)]
    if (!entry) continue
    const validSlot = entry.slot && slotById(entry.slot) ? entry.slot : undefined
    const fact = entry.factId ? factsById.get(entry.factId) : undefined
    if (entry.factId && !fact) continue
    if (!validSlot && !fact) continue
    const adaptedValue = fact && entry.adaptedValue && fact.value.includes(entry.adaptedValue)
      ? entry.adaptedValue
      : undefined
    out.push({
      fieldId,
      slot: validSlot,
      confidence: entry.confidence,
      reason: `${entry.reason}（缓存）`,
      factId: fact?.id,
      adaptedValue
    })
  }
  return out
}

/** 用户改了槽位后，丢掉这一字段上一次的 AI 结论。 */
export async function dropCachedSuggestion(domain: string, fingerprint: string): Promise<void> {
  if (!domain || !fingerprint) return
  const cache = await loadCache()
  let changed = false
  for (const [key, entry] of Object.entries(cache)) {
    if (entry.domain !== domain || entry.fingerprint !== fingerprint) continue
    delete cache[key]
    changed = true
  }
  if (!changed) return
  await chrome.storage.local.set({ [AI_SLOT_CACHE_KEY]: cache })
}

export async function putCachedSuggestions(domain: string, facts: Fact[], entries: Array<{ fingerprint: string; suggestion: SlotSuggestion }>): Promise<void> {
  if (!entries.length) return
  const cache = await loadCache()
  const factsHash = knowledgeFingerprint(facts)
  const now = Date.now()
  for (const { fingerprint, suggestion } of entries) {
    cache[cacheKey(domain, fingerprint, factsHash)] = {
      slot: suggestion.slot, confidence: suggestion.confidence, reason: suggestion.reason,
      factId: suggestion.factId, adaptedValue: suggestion.adaptedValue, at: now,
      domain, fingerprint
    }
  }
  const keys = Object.keys(cache)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => cache[a].at - cache[b].at)
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[key]
  }
  await chrome.storage.local.set({ [AI_SLOT_CACHE_KEY]: cache })
}
