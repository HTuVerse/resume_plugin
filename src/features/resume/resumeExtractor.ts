import { createAiProvider } from '../ai/openaiCompatibleProvider'
import type { AiSettings, Fact } from '../../domain/types'
import { exportProfileTemplate } from '../../infrastructure/transfer/dataTransfer'
import { SECTIONS } from '../ontology/sections'
import { slotsBySection } from '../ontology/slotRegistry'
import { canonicalizeFacts } from '../rag/knowledge'
import { extractFactsByRules, extractResumeText } from './resumeParser'

/**
 * 以知识库模板为底生成表格行：每个板块的全部预设字段都保留，
 * 识别到值的填入，没识别到的留空。模板字段的名称、顺序、板块归属不变；
 * 识别结果中不属于模板的字段追加到对应板块末尾（作为自定义字段）。
 */
function templateRowsFromFacts(extracted: Fact[]): Fact[] {
  const rows: Fact[] = []
  const consumed = new Set<Fact>()
  for (const section of SECTIONS) {
    const slots = slotsBySection(section.id)
    const sectionFacts = extracted.filter(fact => fact.group === section.label)
    const maxItem = sectionFacts.reduce((max, fact) => Math.max(max, fact.item || 1), 1)
    for (let item = 1; item <= maxItem; item += 1) {
      const itemFacts = sectionFacts.filter(fact => (fact.item || 1) === item)
      for (const slot of slots) {
        const canonicalKey = slot.aliases[0]
        const matched = itemFacts.find(fact => fact.key === canonicalKey)
        if (matched) consumed.add(matched)
        rows.push({
          id: crypto.randomUUID(),
          group: section.label,
          item: slot.repeatable ? item : 1,
          key: canonicalKey,
          value: matched?.value || '',
          evidence: matched?.evidence || '',
          source: 'resume'
        })
      }
      // 模板之外的识别结果：保留为该板块的自定义字段，不丢弃
      for (const fact of itemFacts) {
        if (consumed.has(fact)) continue
        consumed.add(fact)
        rows.push({ ...fact, group: section.label, item })
      }
    }
  }
  // 无法归入任何板块的识别结果单独成组保留
  for (const fact of extracted) {
    if (!consumed.has(fact)) rows.push(fact)
  }
  return rows
}

export interface ResumeExtractionResult {
  text: string
  fileName: string
  fileType: 'pdf' | 'docx' | 'txt'
  facts: Fact[]
  /** AI 按模板字段填好的 Excel，用户核对后在「我的信息」中导入知识库。 */
  workbook: Blob
  mode: 'local' | 'ai'
  warning: string
}

export async function extractResume(file: File, useAi: boolean, settings: AiSettings): Promise<ResumeExtractionResult> {
  const parsed = await extractResumeText(file)
  if (!parsed.text) throw new Error('没有提取到文字；扫描件需要先进行 OCR。')
  // 本地规则结果作为兜底：邮箱、手机等强正则命中不会因 AI 遗漏而丢失
  const ruleFacts = canonicalizeFacts(extractFactsByRules(parsed.text))

  let aiFacts: Fact[] = []
  let mode: 'local' | 'ai' = 'local'
  let warning = 'AI 未配置或调用失败，已使用本地规则填写模板，请核对后再导入。'
  if (useAi) {
    try {
      const extraction = await createAiProvider(settings).extractResume(parsed.text)
      if (!extraction.ok) throw new Error(extraction.error)
      aiFacts = extraction.data.facts
      mode = 'ai'
      const partialNote = extraction.data.warnings.length ? `（${extraction.data.warnings.join('；')}）` : ''
      warning = aiFacts.length
        ? `已按模板字段生成表格，请打开 Excel 核对后，在「我的信息」中导入知识库。${partialNote}`
        : `AI 没有从简历中找到可填入模板的内容，表格仅含本地规则识别的结果。${partialNote}`
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误'
      warning = `AI 识别失败，已改用本地规则填写模板。原因：${reason}`
    }
  }
  // AI 结果在前：canonicalizeFacts 按值去重时保留先出现的条目。
  // 表格以完整模板为底：模板字段全部保留，未识别到的值留空。
  const facts = templateRowsFromFacts(canonicalizeFacts([...aiFacts, ...ruleFacts]))
  const workbook = await exportProfileTemplate(facts)
  return { ...parsed, fileName: file.name, facts, workbook, mode, warning }
}
