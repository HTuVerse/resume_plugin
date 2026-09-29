/**
 * 字段本体（Field Ontology）核心类型。
 *
 * Slot 是页面字段与档案 Fact 之间的中间层：两侧各自映射到同一套槽位，
 * 再在槽位上做连接（见 TECH_DESIGN §1/§3）。
 */

export type SectionId =
  | 'personal' | 'education' | 'intention' | 'project' | 'internship'
  | 'campus' | 'award' | 'certificate' | 'skill' | 'family' | 'summary' | 'other'

export type SlotValueType =
  | 'text' | 'longtext' | 'enum' | 'date' | 'month'
  | 'phone' | 'email' | 'number' | 'url' | 'boolean'

export interface SlotDef {
  /** 稳定 ID，永不复用。站点规则与评测集都引用它，改名即破坏兼容。 */
  id: string
  section: SectionId
  /** 档案侧键名与页面侧标签共用的别名表，规范化后全等比较。首个别名为规范名（用于生成 AI schema）。 */
  aliases: string[]
  /**
   * 只在板块已经认出来时才认的旧叫法。
   * 不参与跨板块的标签匹配，避免和别的板块抢同一个名字。
   */
  legacyAliases?: string[]
  /** 别名覆盖不到时的模糊匹配。必须是无副作用的纯正则。 */
  patterns?: RegExp[]
  /** 拉丁标识符（name / id / autocomplete）专用别名，独立于中文别名。 */
  attrAliases?: string[]
  /** 排除项：命中即该槽位得分归零，用于消歧。 */
  excludePatterns?: RegExp[]
  valueType: SlotValueType
  /**
   * 标准值域。valueType === 'enum' 时作为硬校验值域；
   * 其他类型（如民族）仅用于选项集合反推信号（enumSignature）。
   */
  enumValues?: string[]
  /** 该槽位是否随区块重复（教育经历可重复，最高学历不可）。 */
  repeatable: boolean
  /** 默认不自动填写，需用户在设置中逐项开启（F54）。 */
  sensitive: boolean
  maxLengthHint?: number
}

/** 单个槽位的打分结果（F02，供调试面板与决策使用）。 */
export interface SlotScore {
  slot: string
  score: number
  /** 站点规则短路命中时为 true。 */
  locked?: boolean
  signals: Record<string, number>
}

export type SlotDecisionStatus = 'resolved' | 'ambiguous' | 'unknown'

export interface SlotDecision {
  status: SlotDecisionStatus
  slot?: string
  /** Top-N 候选（含得分明细），供面板与 AI 仲裁使用。 */
  candidates: SlotScore[]
}
