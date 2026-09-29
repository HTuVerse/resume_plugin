import type { SlotDecisionStatus, SlotScore } from './slots'

export type DataSource = 'profile' | 'resume' | 'ai' | 'manual'

export type FieldKind = 'text' | 'textarea' | 'select' | 'multiselect' | 'cascade' | 'radio' | 'checkbox' | 'combobox' | 'date'

export type ValueType = FieldKind | 'array'

/** 标签来源级别：来源越弱，打分时标签类信号权重越低（TECH_DESIGN §4.2）。 */
export type LabelSource = 'for' | 'aria' | 'container' | 'sibling' | 'placeholder' | 'none'

export interface Fact {
  id: string
  group: string
  item: number
  key: string
  value: string
  evidence: string
  type?: ValueType
  source?: DataSource
  confidence?: number
  sensitive?: boolean
  updatedAt?: string
}

/** 控件上参与打分的原始属性（F02 信号源）。 */
export interface FieldAttrs {
  name?: string
  id?: string
  autocomplete?: string
  type?: string
  inputmode?: string
}

export interface FormField {
  /** 全局唯一 ID：`${frameId}:${fingerprint}`（顶层 frame 为 0）。 */
  id: string
  /** 稳定字段指纹（F15），页面重渲染后不变。 */
  fingerprint: string
  frameId?: number
  label: string
  labelSource?: LabelSource
  group: string
  /** 区块判定结果（ontology/sections）。 */
  sectionId?: string
  placeholder: string
  kind: FieldKind
  options: string[]
  current: string
  required: boolean
  maxLength: number
  name?: string
  selector?: string
  item?: number
  attrs?: FieldAttrs
  /** 重复段聚类 ID（F06）。 */
  repeatGroupId?: string
  /** 字段附近提示文字（打分信号）。 */
  nearbyText?: string
  /** 槽位判定（在内容脚本扫描时计算）。 */
  slot?: string
  slotStatus?: SlotDecisionStatus
  slotCandidates?: SlotScore[]
  /** 命中的站点规则 ID（F25），用于失败降权统计。 */
  ruleId?: string
}

export interface PageContext {
  pageTitle: string
  url: string
  /** 各 frame 的可达性信息，用于面板提示不可扫描区域。 */
  frames?: Array<{ frameId: number; url: string; fieldCount: number }>
}

export interface FillRequest {
  fieldId: string
  value: string
  overwrite?: boolean
  source?: DataSource
  confidence?: number
  /** 目标槽位，用于同义值重试与结果记录。 */
  slot?: string
}

/** 机器可读失败原因码（F14）。 */
export type FillReasonCode =
  | 'ok' | 'skipped-existing' | 'needs-confirmation'
  | 'no-matching-option' | 'rejected-by-validation'
  | 'cleared-by-rerender' | 'readonly' | 'element-lost'
  | 'option-list-not-found' | 'timeout' | 'unsupported-control'

export interface FillResult {
  fieldId: string
  status: 'filled' | 'skipped' | 'failed'
  message: string
  value?: string
  source?: DataSource
  confidence?: number
  reasonCode?: FillReasonCode
  attempts?: number
  elapsedMs?: number
}

export interface StoredProfile {
  facts: Fact[]
  updatedAt: string
}

export interface ResumeTemplate {
  id: string
  name: string
  description: string
  facts: Fact[]
  createdAt: string
  updatedAt: string
}

export interface CurrentResume {
  id: string
  fileName: string
  fileType: 'pdf' | 'docx' | 'txt'
  extractedText: string
  facts: Fact[]
  parsedAt: string
}

export interface UserProfile {
  id: string
  name: string
  fields: Fact[]
  createdAt: string
  updatedAt: string
}

export interface FieldCandidate {
  fieldId: string
  factId: string
  value: string
  source: DataSource
  confidence: number
  reason: string
  evidence?: string
}

export interface ResolvedField {
  fieldId: string
  factId?: string
  value: string
  source: DataSource | 'empty'
  confidence: number
  reason: string
  candidates: FieldCandidate[]
  status: 'ready' | 'needs-confirmation' | 'empty' | 'skipped'
  /** 待确认理由的机器可读分类（F07）。 */
  reasonCode?: FillReasonCode | 'multiple-candidates' | 'ambiguous-slot' | 'unknown-slot' | 'sensitive-blocked' | 'ai-suggested' | 'value-truncated'
  /** 该字段连接到的槽位。 */
  slot?: string
}

/**
 * AI 字段匹配输出。
 * slot：字段对应的知识库槽位；factId：知识库字段名对不上槽位时，AI 直接指定的条目；
 * adaptedValue：按表单粒度从原值截取出的写入值（必须是原值的子串，本地校验）。
 */
export interface SlotSuggestion {
  fieldId: string
  slot: string
  confidence: number
  reason: string
  factId?: string
  adaptedValue?: string
}

/** 站点规则（F25/F26）：记录「字段指纹 → 槽位」，与档案数据解耦。 */
export interface SiteRule {
  id: string
  domain: string
  urlPattern?: string
  fieldFingerprint: string
  slot: string
  origin: 'user-correction' | 'builtin' | 'imported'
  hitCount: number
  failCount: number
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export interface BackupPayload {
  version: 2 | 3
  exportedAt: string
  /** True when personal fields and the raw imported resume were redacted. */
  redacted?: boolean
  profile: StoredProfile
  templates: ResumeTemplate[]
  currentResume?: CurrentResume
  resumes?: CurrentResume[]
  aiSettings?: AiSettings
  /** v3 新增：站点规则不含个人数据，可不脱敏导出。 */
  siteRules?: SiteRule[]
  /** 学到的字段别名（措辞 → 槽位），不含个人数据。 */
  learnedAliases?: LearnedAlias[]
}

/** 学到的字段别名：某措辞（如「名字」）对应某槽位。 */
export interface LearnedAlias {
  alias: string
  slot: string
  hitCount: number
  updatedAt: string
}

export interface AiSettings {
  url: string
  key: string
  model: string
  provider?: 'openai-compatible'
}
