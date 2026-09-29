/**
 * JSON 解析结果：解析失败时带原因返回，而不是抛异常，
 * 让上层方法把它表达为 AiResult 的失败态（调用方可提示用户重试，而不是整条链路中断）。
 */
export type JsonParseResult =
  | { ok: true; value: any }
  | { ok: false; error: string }

export interface Scan {
  /** 完整闭合的 JSON 片段。 */
  complete: string[]
  /** 扫描结束时仍未闭合的起始位置（输出被截断时用）。 */
  unclosedStarts: number[]
}

export function scanJson(text: string): Scan {
  const complete: string[] = []
  const unclosedStarts: number[] = []
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start]
    if (opener !== '{' && opener !== '[') continue
    const stack: string[] = []
    let inString = false
    let escaped = false
    let closed = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') { inString = true; continue }
      if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '['
        if (stack.pop() !== expected) break
        if (!stack.length) {
          complete.push(text.slice(start, index + 1))
          closed = true
          break
        }
      }
    }
    // 记录仍有未闭合括号的起点（含截断在字符串内部的情况，如 {"key":"专）
    if (!closed && stack.length) unclosedStarts.push(start)
  }
  return { complete, unclosedStarts }
}

/**
 * 统计未闭合的括号（忽略字符串内部），返回需要补齐的闭合符。
 * 截断在字符串内部时先补上缺失的引号。结构已损坏（括号不配对）时返回 null。
 */
function closingSuffix(text: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') stack.push(char)
    else if ((char === '}' || char === ']') && stack.pop() !== (char === '}' ? '{' : '[')) return null
  }
  const closers = stack.reverse().map(opener => (opener === '{' ? '}' : ']')).join('')
  return (inString ? '"' : '') + closers
}

/**
 * 修复被截断的 JSON：推理模型输出到 token 上限时，facts 数组往往写到一半断开。
 * 先截掉末尾未写完的元素（悬空的键、未闭合的对象），再补齐括号，保住已写完的条目。
 */
export function repairTruncated(text: string, unclosedStarts: number[]): unknown {
  // 从最早的未闭合起点开始：截断的通常是最外层对象，内层只是它的残骸。
  // 每次裁剪都基于原始切片，避免沿用上一次已裁短的结果。
  for (let index = 0; index < unclosedStarts.length; index += 1) {
    const original = text.slice(unclosedStarts[index]).trimEnd()
    let cutAt = original.length
    for (let attempt = 0; attempt < 6 && cutAt > 0; attempt += 1) {
      const slice = original.slice(0, cutAt).trimEnd()
      const suffix = closingSuffix(slice)
      if (suffix !== null) {
        try { return dropIncomplete(JSON.parse(slice + suffix)) } catch { /* 继续裁剪 */ }
      }
      // 优先从逗号处截：逗号前的元素是完整的，从 { 或 [ 处截会留下残缺对象
      const comma = slice.lastIndexOf(',')
      cutAt = comma > 0 ? comma : Math.max(slice.lastIndexOf('{'), slice.lastIndexOf('['))
    }
  }
  return undefined
}

/**
 * 去掉截断残留的残缺对象：事实条目必须同时有字段名和值，
 * 缺任何一个的对象是被截断的半条，留着只会变成空值。
 */
function dropIncomplete(value: unknown): unknown {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean).filter(item => item !== undefined)
    if (!node || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    const isFact = 'key' in record || 'value' in record || '字段' in record || '值' in record
    if (isFact && (!String(record.key ?? record['字段'] ?? '').trim() || !String(record.value ?? record['值'] ?? '').trim())) return undefined
    for (const name of Object.keys(record)) record[name] = clean(record[name])
    return record
  }
  return clean(value)
}

function tryParse(candidate: string): unknown {
  try { return JSON.parse(candidate) } catch { return undefined }
}

export function parseJsonResponse(text: string): JsonParseResult {
  const cleaned = String(text || '').trim()
  if (!cleaned) return { ok: false, error: 'AI 返回了空内容。' }
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())
  const scan = scanJson(cleaned)
  // 收集所有能解析出的值：完整片段 + 截断修复结果。
  // 含数组的结果优先（事实列表都是数组），否则取体积最大的，
  // 避免把 {"facts":[{...}]} 误解析成它内层的单条对象。
  const parsed: unknown[] = []
  for (const candidate of [...fenced, ...scan.complete, cleaned]) {
    const value = tryParse(candidate)
    if (value !== undefined) parsed.push(value)
  }
  const repaired = repairTruncated(cleaned, scan.unclosedStarts)
  if (repaired !== undefined) parsed.push(repaired)
  if (!parsed.length) return { ok: false, error: 'AI 返回格式无法解析，请重试。' }
  const rank = (value: unknown): number => JSON.stringify(value).length + (JSON.stringify(value).includes('[') ? 1_000_000 : 0)
  parsed.sort((a, b) => rank(b) - rank(a))
  return { ok: true, value: parsed[0] }
}
