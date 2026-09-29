import { createAiProvider } from '../features/ai/openaiCompatibleProvider'
import { parseJsonResponse } from '../features/ai/responseParser'
import type { AiSettings, Fact, FormField, SlotSuggestion } from '../domain/types'
import { extractResume } from '../features/resume/resumeExtractor'

export async function parseResume(file: File, useAi: boolean, config: AiSettings) {
  return extractResume(file, useAi, config)
}

/** AI 表单匹配：字段元信息 + 知识库内容 → 槽位、引用条目与粒度适配值。 */
export async function suggestSlotMatches(fields: FormField[], facts: Fact[], config: AiSettings): Promise<SlotSuggestion[]> {
  const result = await createAiProvider(config).matchFields(fields, facts)
  if (!result.ok) throw new Error(result.error)
  return result.data.suggestions
}

export async function polishText(original: string, jobDescription: string, maxLength: number, facts: Fact[], config: AiSettings): Promise<string> {
  const result = await createAiProvider(config).polishText(original, jobDescription, maxLength, facts)
  if (!result.ok) throw new Error(result.error)
  return result.data.text
}

export async function testAiConnection(config: AiSettings): Promise<string> {
  const reply = await createAiProvider(config).chat([
    { role: 'system', content: '你是 API 兼容性测试助手。只返回合法 JSON 对象，不要 Markdown 或解释。' },
    { role: 'user', content: '请严格返回 {"ok":true}' }
  ], 0)
  const result = parseJsonResponse(reply)
  if (!result.ok || result.value?.ok !== true) throw new Error('模型可以连接，但未按要求返回结构化 JSON。')
  return 'OK（结构化输出正常）'
}
