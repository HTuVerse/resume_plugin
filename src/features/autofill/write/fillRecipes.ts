import type { FillRecipe } from '../../../domain/types'
import { normalize } from '../../../shared/normalize'
import { normalizeDateValue } from '../../ontology/validators'
import { slotById } from '../../ontology/slotRegistry'

/**
 * 站点填法记忆：某槽位在这个域名上写成功过的日期格式和选项原文。
 * 只记「档案值 → 页面写法」，不另存一份个人档案。
 */

export const FILL_RECIPES_KEY = 'fillRecipesV1'
const MAX_OPTIONS = 40
const MAX_RECIPES = 2000

export function detectDateFormat(value: string): string | undefined {
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'YYYY-MM-DD'
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(text)) return 'YYYY/MM/DD'
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(text)) return 'YYYY.MM.DD'
  if (/^\d{4}年\d{2}月\d{2}日$/.test(text)) return 'YYYY年MM月DD日'
  if (/^\d{4}-\d{2}$/.test(text)) return 'YYYY-MM'
  if (/^\d{4}\/\d{2}$/.test(text)) return 'YYYY/MM'
  if (/^\d{4}\.\d{2}$/.test(text)) return 'YYYY.MM'
  if (/^\d{4}年\d{2}月$/.test(text)) return 'YYYY年MM月'
  return undefined
}

export function formatWithPattern(value: string, format: string): string {
  const monthOnly = !format.includes('DD') && !format.includes('日')
  const norm = normalizeDateValue(value, monthOnly)
  const match = norm.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)
  if (!match) return ''
  const year = match[1]
  const month = match[2]
  const day = match[3] || '01'
  switch (format) {
    case 'YYYY/MM/DD': return `${year}/${month}/${day}`
    case 'YYYY.MM.DD': return `${year}.${month}.${day}`
    case 'YYYY年MM月DD日': return `${year}年${month}月${day}日`
    case 'YYYY-MM-DD': return `${year}-${month}-${day}`
    case 'YYYY/MM': return `${year}/${month}`
    case 'YYYY.MM': return `${year}.${month}`
    case 'YYYY年MM月': return `${year}年${month}月`
    case 'YYYY-MM': return `${year}-${month}`
    default: return ''
  }
}

export function recipeFor(recipes: FillRecipe[], slot: string | undefined): FillRecipe | undefined {
  if (!slot) return undefined
  return recipes.find(recipe => recipe.slot === slot)
}

/** 先尝试本站写成功过的说法，再回退档案原值。 */
export function priorValuesFor(recipe: FillRecipe | undefined, value: string): string[] {
  if (!recipe) return []
  const text = value.trim()
  if (!text) return []
  const out: string[] = []
  const mapped = recipe.options.find(item => item.from === normalize(text))?.to
  if (mapped && mapped.trim() && mapped.trim() !== text) out.push(mapped.trim())
  if (recipe.dateFormat) {
    const formatted = formatWithPattern(text, recipe.dateFormat)
    if (formatted && formatted !== text) out.push(formatted)
  }
  return [...new Set(out)]
}

/**
 * 根据这次写成功的值更新配方。
 * 日期只有在页面接受的格式和档案格式不同时才记。
 * 选项只有在写进去的文字和档案原值不同时才记。
 * 没有新信息时返回 null。
 */
export function nextRecipe(current: FillRecipe | undefined, domain: string, slot: string, requested: string, written: string): FillRecipe | null {
  const from = requested.trim()
  const to = written.trim()
  if (!domain || !slot || !from || !to || !slotById(slot)) return null
  const writtenFormat = detectDateFormat(to)
  const requestedFormat = detectDateFormat(from)
  const dateFormat = writtenFormat && writtenFormat !== requestedFormat ? writtenFormat : current?.dateFormat
  const options = [...(current?.options || [])]
  if (normalize(from) !== normalize(to)) {
    const key = normalize(from)
    const row = { from: key, to }
    const index = options.findIndex(item => item.from === key)
    if (index >= 0) options[index] = row
    else options.push(row)
  }
  const sameFormat = dateFormat === current?.dateFormat
  const sameOptions = options.length === (current?.options.length || 0)
    && options.every((item, index) => item.from === current?.options[index]?.from && item.to === current?.options[index]?.to)
  if (sameFormat && sameOptions) return null
  if (!dateFormat && !options.length) return null
  return {
    domain,
    slot,
    dateFormat,
    options: options.slice(-MAX_OPTIONS),
    updatedAt: new Date().toISOString()
  }
}

function isRecipe(value: unknown): value is FillRecipe {
  if (!value || typeof value !== 'object') return false
  const recipe = value as Partial<FillRecipe>
  return typeof recipe.domain === 'string' && recipe.domain.length <= 300
    && typeof recipe.slot === 'string' && Boolean(slotById(recipe.slot))
    && Array.isArray(recipe.options)
}

export async function loadFillRecipes(domain?: string): Promise<FillRecipe[]> {
  const stored = await chrome.storage.local.get(FILL_RECIPES_KEY)
  const rows = stored[FILL_RECIPES_KEY]
  if (!Array.isArray(rows)) return []
  const recipes = rows.filter(isRecipe).slice(0, MAX_RECIPES)
  return domain ? recipes.filter(recipe => recipe.domain === domain) : recipes
}

export async function saveFillRecipes(recipes: FillRecipe[]): Promise<void> {
  const trimmed = recipes.length > MAX_RECIPES ? recipes.slice(-MAX_RECIPES) : recipes
  await chrome.storage.local.set({ [FILL_RECIPES_KEY]: trimmed })
}

export async function rememberSuccessfulFill(domain: string, slot: string, requested: string, written: string): Promise<void> {
  const all = await loadFillRecipes()
  const current = all.find(recipe => recipe.domain === domain && recipe.slot === slot)
  const next = nextRecipe(current, domain, slot, requested, written)
  if (!next) return
  const rest = all.filter(recipe => !(recipe.domain === domain && recipe.slot === slot))
  await saveFillRecipes([...rest, next])
}
