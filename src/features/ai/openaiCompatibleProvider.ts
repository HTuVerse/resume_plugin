import { parseJsonResponse } from './responseParser'
import { FIELD_MATCHER_SYSTEM, polishSystem, RESUME_EXTRACTOR_RETRY_SYSTEM, RESUME_EXTRACTOR_SYSTEM } from './prompts'
import { slotById } from '../ontology/slotRegistry'
import { factToSlot } from '../autofill/match/factToSlot'
import { aiFail, aiOk, type AiProvider, type AiResult, type ChatMessage, type FieldMatchResult, type PolishResult, type ResumeExtraction } from './aiProvider'
import type { AiSettings, Fact, FormField, SlotSuggestion } from '../../domain/types'

function endpoint(url: string): string {
  const value = url.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(value)) return value
  if (/\/v\d+$/i.test(value)) return `${value}/chat/completions`
  return `${value}/v1/chat/completions`
}

function assertSettings(settings: AiSettings): void {
  if (!settings.url.trim() || !settings.key.trim() || !settings.model.trim()) throw new Error('请先在档案设置中保存 API URL、API Key 和模型名称。')
  if (!/^https?:\/\//i.test(settings.url.trim())) throw new Error('API URL 必须以 http:// 或 https:// 开头。')
}

/** 模型经常不遵守字段名（用中文键、name/content 等），按候选名依次取第一个非空值。 */
function pickString(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function factFromAi(row: any): Fact | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const key = pickString(row, ['key', 'field', 'name', 'label', '字段', '字段名', '键'])
  const value = pickString(row, ['value', 'content', 'text', '值', '内容'])
  if (!key || !value) return null
  const item = Number(pickString(row, ['item', 'index', '条目', '序号']))
  const confidence = Number(row.confidence ?? row.score ?? row.置信度)
  return {
    id: crypto.randomUUID(),
    group: pickString(row, ['group', 'section', 'category', '分组', '板块']) || '待确认',
    item: Number.isFinite(item) && item > 0 ? Math.floor(item) : 1,
    key,
    value,
    evidence: pickString(row, ['evidence', 'source', 'quote', '依据', '原文依据']),
    source: 'resume',
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.8,
    updatedAt: new Date().toISOString()
  }
}

/** facts 数组的位置也不固定：有的模型用 items / data / results，或直接返回数组。 */
function factRowsOf(value: any): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  for (const name of ['facts', 'items', 'data', 'results', 'entries', 'records', 'list']) {
    if (Array.isArray(value[name])) return value[name]
  }
  // 整个对象本身就是一条事实（模型只提取到一项时常见）
  if (factFromAi(value)) return [value]
  return null
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const value = part as Record<string, any>
    if (typeof value.text === 'string') return value.text
    if (typeof value.text?.value === 'string') return value.text.value
    if (typeof value.content === 'string') return value.content
    return ''
  }).join('').trim()
}

function responseContent(body: any): string {
  const choice = body?.choices?.[0]
  const chatContent = contentText(choice?.message?.content ?? choice?.delta?.content ?? choice?.text)
  if (chatContent) return chatContent
  const outputText = contentText(body?.output_text)
  if (outputText) return outputText
  if (!Array.isArray(body?.output)) return ''
  return body.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => contentText(part?.text ?? part?.content)).join('').trim()
}

class EmptyAiResponseError extends Error {}

function providerMessage(body: any): string {
  return String(body?.error?.message || body?.message || '').trim()
}

function emptyResponseError(body: any): EmptyAiResponseError {
  const choice = body?.choices?.[0]
  const finishReason = String(choice?.finish_reason || body?.status || '').trim()
  const message = choice?.message || choice?.delta || {}
  const reasoningLength = contentText(message?.reasoning_content).length
  const refusal = contentText(message?.refusal)
  const promptTokens = Number(body?.usage?.prompt_tokens)
  const completionTokens = Number(body?.usage?.completion_tokens)
  const usage = Number.isFinite(promptTokens) || Number.isFinite(completionTokens)
    ? `（Token：输入 ${Number.isFinite(promptTokens) ? promptTokens : '未知'}，输出 ${Number.isFinite(completionTokens) ? completionTokens : '未知'}）`
    : ''
  if (refusal) return new EmptyAiResponseError(`AI 拒绝生成结果：${refusal.slice(0, 160)}`)
  if (finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'incomplete') {
    // 插件侧已不再传输出上限，这个截断来自模型服务商自身的配置
    return new EmptyAiResponseError(`AI 输出被模型服务商截断，未生成最终正文${reasoningLength ? `（已产生 ${reasoningLength} 字思考内容）` : ''}${usage}。请在服务商控制台调大模型的最大输出长度。`)
  }
  if (finishReason === 'content_filter') return new EmptyAiResponseError('AI 服务因内容审核未返回正文。')
  if (finishReason === 'tool_calls') return new EmptyAiResponseError('AI 返回了工具调用而不是文本结果。')
  const detail = providerMessage(body)
  return new EmptyAiResponseError(`AI 返回了空正文${finishReason ? `（结束原因：${finishReason}）` : ''}${reasoningLength ? `（思考内容 ${reasoningLength} 字）` : ''}${usage}${detail && detail.toLowerCase() !== 'success' ? `：${detail.slice(0, 160)}` : '。'}`)
}

/**
 * 分片尽量大（默认 9000 字符 ≈ 一整份简历）：整份送入可保持
 * 多段经历的 item 编号连续，比小分片的识别完整度高得多。
 */
function splitText(text: string, maxChars = 9_000): string[] {
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end)
      if (newline > start + Math.floor(maxChars * 0.6)) end = newline + 1
    }
    chunks.push(text.slice(start, end).trim())
    start = end
  }
  return chunks.filter(Boolean)
}

function safeFacts(facts: Fact[]): Array<Pick<Fact, 'id' | 'group' | 'item' | 'key' | 'value'>> {
  return facts.slice(0, 500).map(({ id, group, item, key, value }) => ({
    id, group, item, key, value: value.slice(0, 5000)
  }))
}

/** 将不可信的 AI JSON 收敛为可由本地闸门继续处理的建议。 */
export function parseFieldMatchSuggestions(value: any, fields: FormField[], facts: Fact[]): SlotSuggestion[] | null {
  const rows = Array.isArray(value) ? value : value?.matches
  if (!Array.isArray(rows)) return null
  const fieldsById = new Map(fields.map(field => [field.id, field]))
  const factsById = new Map(facts.map(fact => [fact.id, fact]))
  const bestByField = new Map<string, SlotSuggestion>()

  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const fieldId = typeof item.fieldId === 'string' ? item.fieldId : ''
    const field = fieldsById.get(fieldId)
    if (!field) continue

    const requestedSlot = typeof item.slot === 'string' && slotById(item.slot) ? item.slot : undefined
    // 第一层已经认出的页面语义优先，第二层不能把它改到另一个槽位。
    if (field.slot && requestedSlot && field.slot !== requestedSlot) continue

    const fact = typeof item.factId === 'string' ? factsById.get(item.factId) : undefined
    const knownFactSlot = fact ? factToSlot(fact).slot : undefined
    const slot = requestedSlot || field.slot || knownFactSlot
    // 已能由本地本体识别的知识条目，不允许被 AI 指向语义冲突的槽位。
    if (slot && knownFactSlot && slot !== knownFactSlot) continue
    if (!slot && !fact) continue

    const adapted = typeof item.adaptedValue === 'string' ? item.adaptedValue.trim() : ''
    const adaptedValue = fact && adapted && adapted !== fact.value.trim() && fact.value.includes(adapted)
      ? adapted
      : undefined
    const suggestion: SlotSuggestion = {
      fieldId,
      slot,
      factId: fact?.id,
      adaptedValue,
      confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.6)),
      reason: String(item.reason || 'AI 语义判定')
    }
    const previous = bestByField.get(fieldId)
    if (!previous || suggestion.confidence > previous.confidence) bestByField.set(fieldId, suggestion)
  }
  return [...bestByField.values()]
}

export class OpenAICompatibleProvider implements AiProvider {
  constructor(private readonly settings: AiSettings) {}

  /**
   * 不设置 max_tokens / max_completion_tokens：输出长度完全由模型服务商决定，
   * 推理型模型的思考内容不会再挤占正文额度（用户明确要求不做长度限制）。
   */
  async chat(messages: ChatMessage[], temperature = 0.2): Promise<string> {
    assertSettings(this.settings)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000)
    try {
      let includeTemperature = true
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const requestBody: Record<string, unknown> = { model: this.settings.model.trim(), messages, stream: false }
        if (includeTemperature) requestBody.temperature = temperature
        const response = await fetch(endpoint(this.settings.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.key.trim()}` },
          body: JSON.stringify(requestBody), signal: controller.signal
        })
        const body = await response.json().catch(() => ({})) as any
        const errorMessage = providerMessage(body)
        if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
          const unsupportedTemperature = /temperature/i.test(errorMessage) && /unsupported|不支持|does not support/i.test(errorMessage)
          if (unsupportedTemperature && includeTemperature) { includeTemperature = false; continue }
          throw new Error(errorMessage || `AI 请求失败（${response.status}）`)
        }
        const content = responseContent(body)
        if (content) return content
        // 抢救：部分推理模型把最终 JSON 留在思考内容里（正文为空）。
        // 调用方都会用 parseJsonResponse 提取平衡 JSON，直接返回思考文本即可。
        const choice = body?.choices?.[0]
        const reasoning = contentText(choice?.message?.reasoning_content ?? choice?.delta?.reasoning_content)
        if (reasoning && /[{[]/.test(reasoning)) return reasoning
        throw emptyResponseError(body)
      }
      throw new Error('AI 服务不兼容当前请求参数。')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('AI 请求超过 5 分钟，已自动取消。')
      if (error instanceof TypeError) throw new Error('无法连接 AI 服务，请检查 API URL、网络和扩展权限。')
      if (error instanceof Error) throw error
      throw new Error('无法连接 AI 服务，请检查 API URL、网络和扩展权限。')
    } finally {
      clearTimeout(timeout)
    }
  }

  async extractResume(text: string): Promise<AiResult<ResumeExtraction>> {
    const source = text.slice(0, 30_000)
    const chunks = splitText(source)
    const responses: string[] = []
    const warnings: string[] = []
    const extractChunk = async (chunk: string, label: string): Promise<void> => {
      try {
        responses.push(await this.chat([
          { role: 'system', content: RESUME_EXTRACTOR_SYSTEM },
          { role: 'user', content: `这是简历的${label}。请尽可能完整地提取其中明确出现的全部候选事实，保留原文依据；无法确认的内容不要推断。\n\n${chunk}` }
        ], 0.1))
      } catch (error) {
        if (error instanceof EmptyAiResponseError && chunk.length > 1_200) {
          const halves = splitText(chunk, Math.ceil(chunk.length / 2))
          for (let index = 0; index < halves.length; index += 1) await extractChunk(halves[index], `${label}的子片段 ${index + 1}/${halves.length}`)
          return
        }
        throw error
      }
    }
    for (let index = 0; index < chunks.length; index += 1) {
      await extractChunk(chunks[index], chunks.length === 1 ? '全文' : `第 ${index + 1}/${chunks.length} 个片段`)
    }
    const collect = (response: string, index: number): Fact[] => {
      const parsed = parseJsonResponse(response)
      if (!parsed.ok) {
        warnings.push(`第 ${index + 1} 个片段的 AI 输出无法解析`)
        return []
      }
      const rows = factRowsOf(parsed.value)
      if (!rows) {
        warnings.push(`第 ${index + 1} 个片段的 AI 输出里没有找到事实列表`)
        return []
      }
      return rows.flatMap(row => {
        const fact = factFromAi(row)
        return fact ? [fact] : []
      })
    }

    let collected = responses.flatMap((response, index) => collect(response, index))
    // 一次都没提取到时换更直白的提示重试一次：小模型常被字段清单约束到直接返回空数组
    if (!collected.length && chunks.length === 1) {
      warnings.length = 0
      const retry = await this.chat([
        { role: 'system', content: RESUME_EXTRACTOR_RETRY_SYSTEM },
        { role: 'user', content: `请从下面的简历原文中提取全部事实：\n\n${chunks[0]}` }
      ], 0.1)
      collected = collect(retry, 0)
    }

    const seen = new Set<string>()
    const facts: Fact[] = []
    for (const fact of collected) {
      const identity = `${fact.group}|${fact.item}|${fact.key}|${fact.value}`.toLowerCase()
      if (seen.has(identity)) continue
      seen.add(identity)
      facts.push(fact)
    }
    return aiOk({ facts, warnings })
  }

  /**
   * 表单字段 → 知识库匹配：
   * - 字段元信息 + 知识库内容一起送入，AI 负责字段名近义映射和值粒度适配。
   * - 已知字段可返回注册表槽位；本体外字段可只引用真实存在的 factId；
   *   adaptedValue 必须是所引用条目原值的连续子串（防止编造），否则丢弃该项。
   */
  async matchFields(fields: FormField[], facts: Fact[] = []): Promise<AiResult<FieldMatchResult>> {
    if (!fields.length) return aiOk({ suggestions: [] })
    const knowledge = facts.filter(fact => fact.value.trim()).slice(0, 300)
    const parsed = parseJsonResponse(await this.chat([
      { role: 'system', content: FIELD_MATCHER_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          fields: fields.slice(0, 300).map(({ id, label, group, placeholder, kind, options, required, maxLength, item, sectionId, slot, slotStatus }) => ({
            id, label, group, placeholder, kind, options: options.slice(0, 100), required, maxLength, item, section: sectionId,
            localSlot: slot, localStatus: slotStatus
          })),
          knowledge: knowledge.map(({ id, group, item, key, value }) => ({ factId: id, group, item, key, value: value.slice(0, 300) }))
        })
      }
    ]))
    if (!parsed.ok) return aiFail(parsed.error)
    const suggestions = parseFieldMatchSuggestions(parsed.value, fields.slice(0, 300), knowledge)
    if (!suggestions) return aiFail('AI 返回的 JSON 中没有 matches 数组。')
    return aiOk({ suggestions })
  }

  async polishText(original: string, jobDescription: string, maxLength: number, facts: Fact[]): Promise<AiResult<PolishResult>> {
    const text = (await this.chat([
      { role: 'system', content: polishSystem(maxLength) },
      { role: 'user', content: JSON.stringify({ original: original.slice(0, 10_000), jobDescription: jobDescription.slice(0, 20_000), facts: safeFacts(facts) }) }
    ], 0.4)).trim()
    if (!text) return aiFail('AI 返回了空的润色结果。')
    return aiOk({ text })
  }
}

export function createAiProvider(settings: AiSettings): AiProvider {
  return new OpenAICompatibleProvider(settings)
}
