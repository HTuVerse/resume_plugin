import { normalize } from '../../shared/normalize'
import { canonicalValue, degreeRank, sameValue } from './synonyms'

/**
 * 选项匹配策略（TECH_DESIGN §6，闸门第 4 步）。
 *
 * 按优先级短路，找到即返回，绝不跨级回退：
 *   1. 规范化全等
 *   2. 同义值表映射后全等（含地名归一）
 *   3. 有序等级映射（学历这类有序枚举按等级序号比较）
 *   4. 前缀匹配且候选唯一
 *   5. 以上全不中 → 无匹配
 *
 * 旧实现的「双向子串包含」兜底被删除——「高中」⊂「高中及以下」、
 * 「本科」⊂「本科以下」都会命中，是错填的主要来源之一。
 */

export type OptionMatchReason = 'exact' | 'synonym' | 'ordered' | 'prefix'

export interface OptionMatchResult {
  index: number
  reason?: OptionMatchReason
  /** ≥2 个候选时为 true：不得自动选第一个，转待确认。 */
  ambiguous?: boolean
}

const PLACEHOLDER_PATTERN = /^(请选择|选择|全部|select|please\s*select|--+|—+|\s*)$/i
const PROMPT_PATTERN = /^(请选择|请输入|请填写|请搜索|选择或搜索|搜索或选择|点击选择)/
/** 图标字体、勾选方框。读进文本框会变成方块，选项也对不上。 */
const CHOICE_DECORATION = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF☐☑☒✓✔✅✕✖✗✘○◯●◉◎⊙□■▪▫▢▣⬜⬛⚪⚫🔘◦•·∙‧〇囗❑❒◻◼◽◾]/gu
const LEADING_BOX_ANSWER = /^口\s*(是|否|有|无|男|女|对|错|已|未|已婚|未婚|yes|no)$/i

/**
 * 去掉选项前面的方框、勾和对勾。
 * 「口是」收成「是」；「口腔医学」这种真词保留。
 */
export function plainChoiceText(text: string): string {
  const cleaned = String(text || '').replace(CHOICE_DECORATION, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned === '口' || cleaned === '囗') return ''
  const boxed = cleaned.match(LEADING_BOX_ANSWER)
  return boxed ? boxed[1] : cleaned
}

export function isPlaceholderOption(text: string): boolean {
  return PLACEHOLDER_PATTERN.test(String(text || '').trim())
}

/** 占位提示，不是用户填好的值。「选择或搜索生源地」这类整句也算。 */
export function looksLikeFieldPrompt(text: string): boolean {
  const value = String(text || '').trim()
  if (!value) return false
  return isPlaceholderOption(value) || PROMPT_PATTERN.test(value)
}

export function matchOption(options: string[], value: string): OptionMatchResult {
  const target = plainChoiceText(value)
  if (!target) return { index: -1 }
  const usable = options
    .map((text, index) => ({ text: plainChoiceText(text), index }))
    .filter(({ text }) => text && !isPlaceholderOption(text))
  if (!usable.length) return { index: -1 }

  // 1. 规范化全等
  const targetNorm = normalize(target)
  const exact = usable.filter(({ text }) => normalize(text) === targetNorm)
  if (exact.length === 1) return { index: exact[0].index, reason: 'exact' }
  if (exact.length > 1) return { index: exact[0].index, reason: 'exact', ambiguous: true }

  // 2. 同义值表映射后全等（学士 → 本科、北京 → 北京市）
  const synonym = usable.filter(({ text }) => sameValue(text, target))
  if (synonym.length === 1) return { index: synonym[0].index, reason: 'synonym' }
  if (synonym.length > 1) return { index: synonym[0].index, reason: 'synonym', ambiguous: true }

  // 3. 有序等级映射（学历）
  const targetRank = degreeRank(target)
  if (targetRank >= 0) {
    const ordered = usable.filter(({ text }) => degreeRank(text) === targetRank)
    if (ordered.length === 1) return { index: ordered[0].index, reason: 'ordered' }
    if (ordered.length > 1) return { index: ordered[0].index, reason: 'ordered', ambiguous: true }
  }

  // 4. 前缀匹配且候选唯一（长度 ≥2 才有意义）
  if (targetNorm.length >= 2) {
    const targetCanonical = canonicalValue(target)
    const prefix = usable.filter(({ text }) => {
      const optionNorm = normalize(text)
      return optionNorm.startsWith(targetNorm) || optionNorm.startsWith(targetCanonical)
    })
    if (prefix.length === 1) return { index: prefix[0].index, reason: 'prefix' }
  }

  return { index: -1 }
}

/** 值与选项文本是否可视为一致（写入回读比对用，kind 感知的宽松版本）。 */
export function optionEquivalent(actual: string, expected: string): boolean {
  if (sameValue(actual, expected)) return true
  const rankA = degreeRank(actual)
  return rankA >= 0 && rankA === degreeRank(expected)
}
