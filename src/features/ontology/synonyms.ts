import { normalize } from '../../shared/normalize'

/**
 * 同义值归一化表（F05）。
 * 每组第一个值为规范值；组内任意值经 canonicalValue() 归一到规范值。
 */

const SYNONYM_GROUPS: string[][] = [
  // 学历（与 DEGREE_LADDER 对齐）
  ['小学'],
  ['初中'],
  ['高中', '普通高中'],
  ['中专', '中职', '职高', '技校'],
  ['大专', '专科', '高职', '高职高专'],
  ['本科', '学士', '大学本科', 'bachelor'],
  ['硕士', '研究生', '硕士研究生', 'master'],
  ['博士', '博士研究生', 'phd', 'doctor'],
  // 学位
  ['学士学位', '工学学士', '理学学士', '文学学士'],
  // 政治面貌
  ['中共党员', '党员', '中国共产党党员', '中共正式党员'],
  ['中共预备党员', '预备党员'],
  ['共青团员', '团员', '中国共产主义青年团团员'],
  ['群众', '普通居民', '无党派'],
  // 性别
  ['男', '男性', 'male'],
  ['女', '女性', 'female'],
  // 婚姻状况
  ['未婚', '单身'],
  ['已婚'],
  // 是否类布尔
  ['是', '有', '已', '同意', '接受', '愿意', 'true', 'yes', 'y', '1'],
  ['否', '无', '未', '不同意', '不接受', '不愿意', 'false', 'no', 'n', '0'],
  // 工作性质
  ['全职', '全职工作'],
  ['兼职'],
  ['实习', '实习生'],
  // 培养方式
  ['全日制', '统招', '统招全日制'],
  ['非全日制', '在职'],
  // 英语水平
  ['cet4', '大学英语四级', '英语四级', '四级', 'cet-4'],
  ['cet6', '大学英语六级', '英语六级', '六级', 'cet-6'],
  ['专业四级', '专四', 'tem4', 'tem-4'],
  ['专业八级', '专八', 'tem8', 'tem-8']
]

/** 学历有序等级（低 → 高），用于有序枚举的等级匹配（§6 选项匹配第 3 级）。 */
export const DEGREE_LADDER = ['小学', '初中', '高中', '中专', '大专', '本科', '硕士', '博士']

const canonicalByValue = new Map<string, string>()
for (const group of SYNONYM_GROUPS) {
  for (const value of group) canonicalByValue.set(normalize(value), group[0])
}

/** 城市 / 行政区划后缀，用于「北京 ↔ 北京市」双向归一。 */
function stripRegionSuffix(value: string): string {
  return value.replace(/(省|市|自治区|特别行政区|自治州|地区)$/u, '')
}

/** 将任意值归一为规范值；无同义组时返回规范化原值。 */
export function canonicalValue(value: string): string {
  const key = normalize(value)
  return canonicalByValue.get(key) || key
}

/** 两个值在同义值 / 地名归一意义下是否等同。 */
export function sameValue(a: string, b: string): boolean {
  if (!a?.trim() || !b?.trim()) return false
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return true
  if (canonicalValue(a) === canonicalValue(b)) return true
  const ra = normalize(stripRegionSuffix(a.trim()))
  const rb = normalize(stripRegionSuffix(b.trim()))
  return ra.length > 0 && ra === rb
}

/** 学历等级序号；不是学历值时返回 -1。 */
export function degreeRank(value: string): number {
  const canonical = canonicalValue(value)
  return DEGREE_LADDER.findIndex(step => normalize(step) === canonical)
}

/** 是否类布尔：返回 true / false / null（无法判定）。 */
export function booleanValue(value: string): boolean | null {
  const canonical = canonicalValue(value)
  if (canonical === normalize('是')) return true
  if (canonical === normalize('否')) return false
  if (/^(是|有|已|同意|接受|愿意)/.test(value.trim())) return true
  if (/^(否|无|未|不)/.test(value.trim())) return false
  return null
}

/**
 * 同义候选值展开（写入失败后按同义值重试用，F14 重试策略）。
 * 返回除原值外可尝试的其他写法，按优先级排序。
 */
export function expandCandidates(value: string): string[] {
  const key = canonicalValue(value)
  const group = SYNONYM_GROUPS.find(item => normalize(item[0]) === key)
  const out: string[] = []
  if (group) out.push(...group.filter(item => normalize(item) !== normalize(value)))
  const trimmed = value.trim()
  const stripped = stripRegionSuffix(trimmed)
  if (stripped && stripped !== trimmed) out.push(stripped)
  else if (/^[\u4e00-\u9fa5]{2,3}$/.test(trimmed) && !/[省市区县]$/.test(trimmed)) out.push(`${trimmed}市`)
  return [...new Set(out)]
}
