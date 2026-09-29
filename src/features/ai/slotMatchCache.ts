import type { SlotSuggestion } from '../../domain/types'
import { shortHash } from '../autofill/scan/fingerprint'
import { SLOT_REGISTRY_VERSION, slotById } from '../ontology/slotRegistry'

/**
 * AI 槽位匹配缓存（F43）。
 * 缓存键 = hash(domain + 字段指纹 + slotRegistryVersion)。
 * 不含 Fact——AI 输出已不依赖档案，换简历不需要失效缓存；
 * 词典升级时 SLOT_REGISTRY_VERSION 递增，缓存自动失效。
 */

export const AI_SLOT_CACHE_KEY = 'aiSlotCacheV1'
const MAX_ENTRIES = 2000

interface CacheEntry {
  slot: string
  confidence: number
  reason: string
  /** AI 指定的知识库条目（字段名近义映射）；知识库变动后由读取方校验其仍存在。 */
  factId?: string
  /** 按表单粒度截取的值（原值的连续子串）。 */
  adaptedValue?: string
  at: number
}

function cacheKey(domain: string, fingerprint: string): string {
  return shortHash(`${domain}|${fingerprint}|${SLOT_REGISTRY_VERSION}`)
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
  const result = await chrome.storage.local.get(AI_SLOT_CACHE_KEY)
  const stored = result[AI_SLOT_CACHE_KEY]
  return stored && typeof stored === 'object' ? stored as Record<string, CacheEntry> : {}
}

export async function getCachedSuggestions(domain: string, fingerprints: Array<{ fieldId: string; fingerprint: string }>): Promise<SlotSuggestion[]> {
  const cache = await loadCache()
  const out: SlotSuggestion[] = []
  for (const { fieldId, fingerprint } of fingerprints) {
    const entry = cache[cacheKey(domain, fingerprint)]
    if (entry && slotById(entry.slot)) {
      out.push({ fieldId, slot: entry.slot, confidence: entry.confidence, reason: `${entry.reason}（缓存）`, factId: entry.factId, adaptedValue: entry.adaptedValue })
    }
  }
  return out
}

export async function putCachedSuggestions(domain: string, entries: Array<{ fingerprint: string; suggestion: SlotSuggestion }>): Promise<void> {
  if (!entries.length) return
  const cache = await loadCache()
  const now = Date.now()
  for (const { fingerprint, suggestion } of entries) {
    cache[cacheKey(domain, fingerprint)] = {
      slot: suggestion.slot, confidence: suggestion.confidence, reason: suggestion.reason,
      factId: suggestion.factId, adaptedValue: suggestion.adaptedValue, at: now
    }
  }
  const keys = Object.keys(cache)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => cache[a].at - cache[b].at)
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[key]
  }
  await chrome.storage.local.set({ [AI_SLOT_CACHE_KEY]: cache })
}
