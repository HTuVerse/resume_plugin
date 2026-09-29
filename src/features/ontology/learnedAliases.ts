import type { LearnedAlias } from '../../domain/types'
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

export async function loadLearnedAliases(): Promise<LearnedAlias[]> {
  const stored = await chrome.storage.local.get(LEARNED_ALIASES_KEY)
  const rows = stored[LEARNED_ALIASES_KEY]
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is LearnedAlias => Boolean(row)
    && typeof row.alias === 'string' && row.alias.trim().length > 0 && row.alias.length <= 40
    && typeof row.slot === 'string' && Boolean(slotById(row.slot)))
}

export async function saveLearnedAliases(aliases: LearnedAlias[]): Promise<void> {
  await chrome.storage.local.set({ [LEARNED_ALIASES_KEY]: aliases.slice(0, 2000) })
}

/**
 * 学习一个别名。返回 false 表示无需学习：标签为空、与槽位内置别名重复，
 * 或该标签已被学到其他槽位（冲突时不覆盖，避免一次误选污染全局）。
 */
export async function learnAlias(alias: string, slot: string): Promise<boolean> {
  const text = alias.trim()
  if (!text || text.length > 40 || !slotById(slot)) return false
  const def = slotById(slot)!
  if (def.aliases.some(item => item.trim() === text)) return false
  const aliases = await loadLearnedAliases()
  const existing = aliases.find(item => item.alias === text)
  if (existing) {
    if (existing.slot !== slot) return false
    existing.hitCount += 1
    existing.updatedAt = new Date().toISOString()
  } else {
    aliases.push({ alias: text, slot, hitCount: 1, updatedAt: new Date().toISOString() })
  }
  await saveLearnedAliases(aliases)
  return true
}

export async function removeLearnedAlias(alias: string): Promise<void> {
  const aliases = await loadLearnedAliases()
  await saveLearnedAliases(aliases.filter(item => item.alias !== alias))
}
