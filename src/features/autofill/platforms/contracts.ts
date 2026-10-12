import type { ControlCapabilities, UniversalControlType } from '../control/model'

export type AtsPlatformFamily = 'moka' | 'beisen' | 'feishu'

export interface PlatformControlHint {
  selector: string
  type: UniversalControlType
  confidence?: number
  evidence: string
  capabilities?: Partial<ControlCapabilities>
}

export interface PlatformSelectors {
  formItem: string
  label: string
  section: string
  repeatItem: string
  select: string
  cascade: string
  date: string
  popup: string
  option: string
  selectionItem: string
  searchInput: string
  choiceWrapper: string
  radioGroup: string
  checkboxGroup: string
  addButton: string
  range: string
}

/**
 * 招聘平台只声明页面能力，不接管整条填写流水线。
 * 通用扫描、语义匹配、写入和回读仍是唯一实现，避免同页混用组件库时互相排斥。
 */
export interface PlatformAdapter {
  id: string
  family: AtsPlatformFamily
  name: string
  version: string
  priority: number
  hostPatterns: RegExp[]
  pathPatterns?: RegExp[]
  /** 允许企业自定义域名时，至少命中多少个 DOM 特征才可启用。 */
  indicatorOnlyThreshold: number
  indicators: string[]
  selectors: PlatformSelectors
  controls: PlatformControlHint[]
  settleDelayMs: number
}

export interface PlatformMatch {
  adapter: PlatformAdapter
  confidence: number
  evidence: string[]
}

