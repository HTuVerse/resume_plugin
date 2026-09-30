import type { LearnedAlias } from '../../domain/types'
import { normalize } from '../../shared/normalize'
import { slotById } from './slotRegistry'

/**
 * 字段别名学习（用户需求：姓名 / 名字这类措辞差异要越用越准）。
 *
 * 别名属于「措辞 → 槽位」的知识，不含任何个人数据，因此与站点规则一样
 * 存在本地、可随备份导入导出。学习来源是用户的确认行为：
 * 在填写面板里把某字段改选为某条知识库数据时，该字段的标签即成为该槽位的别名。
 * 下次任何网站出现相同标签，字段匹配会直接按别名命中。
 */

export const LEARNED_ALIASES_KEY = 'learnedAliasesV1'
export type { LearnedAlias }

function aliasKey(alias: string, sectionId?: string): string {
  return `${sectionId || ''}\0${alias}`
}

function coerceAlias(row: LearnedAlias): LearnedAlias | null {
  if (!row || typeof row.alias !== 'string' || typeof row.slot !== 'string' || !slotById(row.slot)) return null
  const alias = normalize(row.alias)
  if (!alias || row.alias.trim().length > 40) return null
  const sectionId = typeof row.sectionId === 'string' && row.sectionId ? row.sectionId : undefined
  return {
    alias,
    slot: row.slot,
    sectionId,
    hitCount: Number(row.hitCount) || 0,
    failCount: Number(row.failCount) || 0,
    disabled: Boolean(row.disabled),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ''
  }
}

export async function loadLearnedAliases(): Promise<LearnedAlias[]> {
  const stored = await chrome.storage.local.get(LEARNED_ALIASES_KEY)
  const rows = stored[LEARNED_ALIASES_KEY]
  if (!Array.isArray(rows)) return []
  const merged = new Map<string, LearnedAlias>()
  for (const row of rows) {
    const alias = coerceAlias(row)
    if (!alias) continue
    const key = aliasKey(alias.alias, alias.sectionId)
    const current = merged.get(key)
    if (!current || alias.hitCount > current.hitCount || (alias.hitCount === current.hitCount && alias.updatedAt > current.updatedAt)) {
      merged.set(key, alias)
    }
  }
  return [...merged.values()]
}

export async function saveLearnedAliases(aliases: LearnedAlias[]): Promise<void> {
  await chrome.storage.local.set({ [LEARNED_ALIASES_KEY]: aliases.slice(0, 2000) })
}

/**
 * 学习一个别名。比较前先规范化，所以「姓名：」「*姓名」和「姓名」是同一条。
 * 返回 skipped 表示无需学习：标签为空、与该槽位内置别名重复。
 * 返回 conflict 表示该标签已指向其他槽位，且这次不是用户确认覆盖。
 * overwrite 用于面板里用户改选、确认入库：冲突时改指向，并重新启用。
 * 命中次数只在填写成功时累加，这里只建立或改指向。
 */
export type LearnAliasResult = 'saved' | 'unchanged' | 'conflict' | 'skipped'

export async function learnAlias(alias: string, slot: string, options?: { overwrite?: boolean; sectionId?: string }): Promise<LearnAliasResult> {
  const raw = alias.trim()
  const text = normalize(raw)
  const sectionId = options?.sectionId || undefined
  if (!text || raw.length > 40 || !slotById(slot)) return 'skipped'
  const def = slotById(slot)!
  if (!sectionId && def.aliases.some(item => normalize(item) === text)) return 'skipped'
  const aliases = await loadLearnedAliases()
  const existing = aliases.find(item => item.alias === text && (item.sectionId || '') === (sectionId || ''))
  const now = new Date().toISOString()
  if (existing) {
    if (existing.slot !== slot) {
      if (!options?.overwrite) return 'conflict'
      existing.slot = slot
      existing.hitCount = 0
      existing.failCount = 0
      existing.disabled = false
    } else if (options?.overwrite && existing.disabled) {
      existing.disabled = false
    } else {
      return 'unchanged'
    }
    existing.updatedAt = now
  } else {
    aliases.push({ alias: text, slot, sectionId, hitCount: 0, failCount: 0, disabled: false, updatedAt: now })
  }
  await saveLearnedAliases(aliases)
  return 'saved'
}

/** 别名命中且填写成功。 */
export async function recordAliasHit(alias: string, sectionId?: string): Promise<void> {
  const key = normalize(alias)
  const aliases = await loadLearnedAliases()
  const row = aliases.find(item => item.alias === key && (!sectionId || item.sectionId === sectionId)) || aliases.find(item => item.alias === key && !item.sectionId)
  if (!row) return
  row.hitCount += 1
  row.updatedAt = new Date().toISOString()
  await saveLearnedAliases(aliases)
}

/**
 * 别名命中后写入仍失败时降权。
 * failCount ≥ 3 且多于命中次数时停用，避免一次学错的措辞一直锁死。
 */
export async function recordAliasFailure(alias: string, sectionId?: string): Promise<void> {
  const key = normalize(alias)
  const aliases = await loadLearnedAliases()
  const row = aliases.find(item => item.alias === key && (!sectionId || item.sectionId === sectionId)) || aliases.find(item => item.alias === key && !item.sectionId)
  if (!row) return
  row.failCount = (row.failCount || 0) + 1
  if (row.failCount >= 3 && row.failCount > row.hitCount) row.disabled = true
  row.updatedAt = new Date().toISOString()
  await saveLearnedAliases(aliases)
}

export async function setAliasDisabled(alias: string, sectionId: string | undefined, disabled: boolean): Promise<void> {
  const key = normalize(alias)
  const aliases = await loadLearnedAliases()
  const row = aliases.find(item => item.alias === key && (item.sectionId || '') === (sectionId || ''))
  if (!row || row.disabled === disabled) return
  row.disabled = disabled
  row.updatedAt = new Date().toISOString()
  await saveLearnedAliases(aliases)
}

export async function removeLearnedAlias(alias: string, sectionId?: string): Promise<void> {
  const key = normalize(alias)
  const aliases = await loadLearnedAliases()
  await saveLearnedAliases(aliases.filter(item => !(item.alias === key && (item.sectionId || '') === (sectionId || ''))))
}
