import type { Fact, FormField, SlotSuggestion } from '../../domain/types'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * AI 调用的统一结果（判别联合）。
 *
 * 之前各方法直接返回裸数据或抛异常：JSON 解析失败、模型没按格式回答时，
 * 调用方只能 catch 后整体重试，拿不到「解析失败」与「网络失败」的区别。
 * 现在结构化方法一律返回 AiResult：ok 时带类型化 data，失败时带 error，
 * 调用方用 result.ok 收窄，不再面对 any 和字符串。
 */
export type AiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export function aiOk<T>(data: T): AiResult<T> {
  return { ok: true, data }
}

export function aiFail<T>(error: string): AiResult<T> {
  return { ok: false, error }
}

/** 简历提取结果：facts 为成功解析的条目，warnings 记录被跳过的片段及原因。 */
export interface ResumeExtraction {
  facts: Fact[]
  warnings: string[]
}

/** 字段 → 槽位仲裁结果。 */
export interface FieldMatchResult {
  suggestions: SlotSuggestion[]
}

/** 润色结果。 */
export interface PolishResult {
  text: string
}

export interface AiProvider {
  /** 不携带输出长度限制：由模型服务商决定，避免推理模型思考内容挤占正文。 */
  chat(messages: ChatMessage[], temperature?: number): Promise<string>
  extractResume(text: string): Promise<AiResult<ResumeExtraction>>
  /**
   * 表单字段 → 知识库匹配。facts 为知识库内容（字段名 + 值），
   * 用于字段名近义映射与按表单粒度截取值；返回的值本地校验后才使用。
   */
  matchFields(fields: FormField[], facts?: Fact[]): Promise<AiResult<FieldMatchResult>>
  polishText(original: string, jobDescription: string, maxLength: number, facts: Fact[]): Promise<AiResult<PolishResult>>
}
