import type { AiSettings } from '../../domain/types'
import { loadAiSettings, VISUAL_CAPABILITY_KEY } from '../../infrastructure/storage/store'
import type { AiVisualDecision, RankedVisualCandidate, VisualBox } from '../autofill/write/visualConsensus'
import { parseJsonResponse } from './responseParser'

function endpoint(url: string): string {
  const value = url.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(value)) return value
  if (/\/v\d+$/i.test(value)) return `${value}/chat/completions`
  return `${value}/v1/chat/completions`
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const row = part as Record<string, any>
    return typeof row.text === 'string' ? row.text : typeof row.text?.value === 'string' ? row.text.value : ''
  }).join('').trim()
}

function responseContent(body: any): string {
  const choice = body?.choices?.[0]
  const chat = contentText(choice?.message?.content ?? choice?.delta?.content ?? choice?.text)
  if (chat) return chat
  const outputText = contentText(body?.output_text)
  if (outputText) return outputText
  return Array.isArray(body?.output)
    ? body.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []).map((part: any) => contentText(part?.text ?? part?.content)).join('').trim()
    : ''
}

function configured(settings: AiSettings): boolean {
  return Boolean(settings.url.trim() && settings.key.trim() && settings.model.trim() && /^https?:\/\//i.test(settings.url.trim()))
}

export async function visualAiConfigured(): Promise<boolean> {
  return configured(await loadAiSettings())
}

export interface VisualCapabilityState {
  status: 'unknown' | 'ready' | 'failed'
  testedAt?: string
  error?: string
}

function capabilityIdentity(settings: AiSettings): string {
  return `${endpoint(settings.url)}|${settings.model.trim()}`.toLowerCase()
}

async function rememberVisualCapability(settings: AiSettings, state: VisualCapabilityState): Promise<void> {
  await chrome.storage.local.set({
    [VISUAL_CAPABILITY_KEY]: { ...state, identity: capabilityIdentity(settings) }
  })
}

export async function visualCapabilityState(settings?: AiSettings): Promise<VisualCapabilityState> {
  const current = settings || await loadAiSettings()
  if (!configured(current)) return { status: 'unknown' }
  const stored = (await chrome.storage.local.get(VISUAL_CAPABILITY_KEY))[VISUAL_CAPABILITY_KEY] as (VisualCapabilityState & { identity?: string }) | undefined
  if (!stored || stored.identity !== capabilityIdentity(current)) return { status: 'unknown' }
  return { status: stored.status, testedAt: stored.testedAt, error: stored.error }
}

/**
 * 设置页图片能力测试。随机令牌只画在图片里，文本提示不包含答案；
 * 因此普通文本接口即使可连接，也不能把“已配置”伪装成“支持图片”。
 */
export async function testVisualImageCapability(settings: AiSettings, imageUrl: string, expectedText: string): Promise<void> {
  if (!configured(settings)) throw new Error('请先完整填写有效的 AI 配置。')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)
  try {
    const response = await fetch(endpoint(settings.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key.trim()}` },
      body: JSON.stringify({
        model: settings.model.trim(),
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '读取图片中央的测试令牌。只返回 JSON：{"text":"图片中的令牌"}。不要猜测。' },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
          ]
        }]
      }),
      signal: controller.signal
    })
    const body = await response.json().catch(() => ({})) as any
    if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
      throw new Error(String(body?.error?.message || body?.message || `视觉 AI 请求失败（${response.status}）`))
    }
    const content = responseContent(body)
    const parsed = parseJsonResponse(content)
    const actual = parsed.ok && parsed.value && typeof parsed.value === 'object'
      ? String((parsed.value as Record<string, unknown>).text || '')
      : ''
    const normalized = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!actual || normalized(actual) !== normalized(expectedText)) {
      throw new Error('模型可以响应，但没有正确读取图片中的随机令牌；该模型可能不支持图片输入。')
    }
    await rememberVisualCapability(settings, { status: 'ready', testedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? '视觉图片测试超时。'
      : error instanceof Error ? error.message : `视觉图片测试失败：${String(error)}`
    await rememberVisualCapability(settings, { status: 'failed', testedAt: new Date().toISOString(), error: message.slice(0, 240) })
    throw new Error(message)
  } finally {
    clearTimeout(timeout)
  }
}

function normalizedBox(box: VisualBox, width: number, height: number): VisualBox {
  return {
    left: Math.round(box.left / width * 1000),
    top: Math.round(box.top / height * 1000),
    right: Math.round(box.right / width * 1000),
    bottom: Math.round(box.bottom / height * 1000)
  }
}

export function parseVisualDecision(text: string, allowedIds: Set<string>): AiVisualDecision {
  const parsed = parseJsonResponse(text)
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return { available: true, error: parsed.ok ? '视觉 AI 返回格式无效' : parsed.error }
  const value = parsed.value as Record<string, unknown>
  const candidateId = typeof value.candidateId === 'string' ? value.candidateId : typeof value.candidate_id === 'string' ? value.candidate_id : ''
  const confidence = Math.max(0, Math.min(1, Number(value.confidence) || 0))
  if (!candidateId || !allowedIds.has(candidateId)) {
    return { available: true, confidence, reason: String(value.reason || ''), error: '视觉 AI 未选择有效的 OCR 候选' }
  }
  return { available: true, candidateId, confidence, reason: String(value.reason || '') }
}

export async function verifyVisualCandidate(
  image: string,
  targets: string[],
  mode: 'option' | 'verify',
  candidates: RankedVisualCandidate[],
  imageSize: { width: number; height: number }
): Promise<AiVisualDecision> {
  const settings = await loadAiSettings()
  if (!configured(settings)) return { available: false, error: '视觉 AI 未配置；请在设置中填写支持图片输入的模型' }
  const shortlist = candidates.slice(0, 40)
  if (!shortlist.length) return { available: true, error: '没有可供视觉 AI 复核的 OCR 候选' }
  const prompt = JSON.stringify({
    task: mode === 'option' ? '在下拉选项中选择与目标值语义相同的唯一候选' : '确认输入框当前显示的值与目标值相同',
    targets,
    coordinateSystem: '候选框使用相对图片的 0-1000 坐标，仅用于辅助观察',
    candidates: shortlist.map(item => ({
      candidateId: item.id,
      ocrText: item.text,
      box: normalizedBox(item.box, Math.max(1, imageSize.width), Math.max(1, imageSize.height))
    })),
    output: { candidateId: '必须从 candidates 中选择；无法确认则为空字符串', confidence: '0 到 1', reason: '简短理由' }
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestBody: Record<string, unknown> = {
        model: settings.model.trim(),
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `你是网页表单视觉复核器。必须结合截图和 OCR 候选，只输出一个 JSON 对象，不要猜测。\n${prompt}` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}`, detail: 'high' } }
          ]
        }]
      }
      if (attempt === 0) requestBody.temperature = 0
      const response = await fetch(endpoint(settings.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key.trim()}` },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      })
      const body = await response.json().catch(() => ({})) as any
      if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
        const error = String(body?.error?.message || body?.message || `视觉 AI 请求失败（${response.status}）`)
        if (attempt === 0 && /temperature/i.test(error) && /unsupported|不支持|does not support/i.test(error)) continue
        return { available: false, error }
      }
      const content = responseContent(body)
      if (!content) return { available: true, error: '视觉 AI 返回了空内容' }
      return parseVisualDecision(content, new Set(shortlist.map(item => item.id)))
    }
    return { available: false, error: '视觉 AI 不兼容当前请求参数' }
  } catch (error) {
    return {
      available: false,
      error: error instanceof DOMException && error.name === 'AbortError'
        ? '视觉 AI 复核超时'
        : `视觉 AI 无法连接或模型不支持图片输入：${String(error)}`
    }
  } finally {
    clearTimeout(timeout)
  }
}
