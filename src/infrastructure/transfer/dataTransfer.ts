import type { Fact } from '../../domain/types'
import { mergeIntoKnowledge } from '../../features/rag/knowledge'
import { isSensitiveField, maskValue } from '../privacy/privacy'

const HEADERS = ['分组', '条目', '字段', '值', '原文依据']
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024
const MAX_IMPORT_ROWS = 5000

export interface ProfileImportMergeResult {
  facts: Fact[]
  added: number
  updated: number
}

function rows(facts: Fact[], redactSensitive: boolean): string[][] {
  return facts.map(fact => [
    fact.group,
    String(fact.item),
    fact.key,
    redactSensitive && isSensitiveField(fact.key) ? maskValue(fact.value) : fact.value,
    redactSensitive && isSensitiveField(fact.key) ? (fact.evidence ? '[已脱敏]' : '') : fact.evidence || ''
  ])
}

export async function exportFacts(facts: Fact[], format: 'xlsx' | 'csv', redactSensitive = true): Promise<Blob> {
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet([HEADERS, ...rows(facts, redactSensitive)])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '简历档案')
  // UTF-8 BOM keeps Chinese headers readable when the CSV is opened directly
  // in desktop Excel.
  if (format === 'csv') return new Blob(['\ufeff', XLSX.utils.sheet_to_csv(sheet)], { type: 'text/csv;charset=utf-8' })
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
  return new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

/** Excel 工作表名限制：≤31 字符，且不能包含 [ ] : * ? / \。 */
function sheetNameOf(group: string): string {
  const cleaned = group.replace(/[[\]:*?/\\]/g, '·').replace(/\s+/g, ' ').trim() || '其他'
  return cleaned.slice(0, 31)
}

const SECTION_SHEET_HEADERS = ['条目', '字段', '值', '说明 / 原文依据']

/**
 * 生成按板块分工作表的批量维护模板：
 * - 每个板块（基本信息、教育经历……）一个工作表，预设字段全部列出；
 * - 已填写的值一并写入，模板同时可作为用户可控的本地备份；
 * - 用户可在任意板块工作表末尾新增行来添加自定义字段（填「字段 + 值」即可）。
 */
export async function exportProfileTemplate(facts: Fact[]): Promise<Blob> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()

  const groups: string[] = []
  const byGroup = new Map<string, Fact[]>()
  for (const fact of facts) {
    const group = fact.group.trim() || '其他'
    if (!byGroup.has(group)) { byGroup.set(group, []); groups.push(group) }
    byGroup.get(group)!.push(fact)
  }

  const instructions = XLSX.utils.aoa_to_sheet([
    ['填写说明'],
    ['1', '每个板块（基本信息、教育经历、项目经验……）对应一个工作表，请在对应工作表的“值”列填写或修改内容。'],
    ['2', '“条目”用于区分多段经历：第一段教育经历填 1，第二段填 2，以此类推；可复制整组字段行后修改编号来新增一段。'],
    ['3', '需要插件没有预设的字段时，直接在对应板块工作表末尾新增一行，填写“字段”和“值”即可（自定义字段同样会参与自动填写）。'],
    ['4', '不需要填写的字段可留空；导入时只处理“值”不为空的行。'],
    ['5', '导入会更新同名字段并新增缺少字段，不会删除表格中未出现的现有信息。'],
    ['6', '请不要修改工作表名称和“条目”“字段”两列的表头，它们用于识别数据归属。'],
    ['隐私提示', '表格可能包含个人敏感信息，请保存在可信设备中并妥善保管。']
  ])
  instructions['!cols'] = [{ wch: 12 }, { wch: 96 }]
  XLSX.utils.book_append_sheet(workbook, instructions, '填写说明')

  for (const group of groups) {
    const groupRows = byGroup.get(group)!
    const sheet = XLSX.utils.aoa_to_sheet([
      SECTION_SHEET_HEADERS,
      ...groupRows.map(fact => [String(Math.max(1, fact.item || 1)), fact.key, fact.value, fact.evidence || ''])
    ])
    sheet['!cols'] = [{ wch: 6 }, { wch: 24 }, { wch: 52 }, { wch: 32 }]
    XLSX.utils.book_append_sheet(workbook, sheet, sheetNameOf(group))
  }

  workbook.Props = { Title: '我的信息批量维护模板', Subject: '鸿途网申助手个人信息模板（按板块分表）' }
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
  return new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function text(row: Record<string, unknown>, names: string[]): string {
  const aliases = names.map(item => item.trim().toLowerCase())
  const key = Object.keys(row).find(item => aliases.includes(item.trim().toLowerCase()))
  return key ? String(row[key] ?? '').trim() : ''
}

/**
 * 导入表格（兼容两种格式）：
 * - 新版分板块模板：每个板块一个工作表，分组取工作表名；
 * - 旧版单表格式：首个工作表带“分组”列，分组取该列。
 * 任意板块工作表中用户自行新增的行会作为自定义字段导入。
 */
export async function importFacts(file: File): Promise<Fact[]> {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('仅支持 XLSX、XLS 或 CSV 表格。')
  if (file.size > MAX_IMPORT_FILE_SIZE) throw new Error('表格文件不能超过 10 MB。')
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const facts: Fact[] = []
  let totalRows = 0
  for (const sheetName of workbook.SheetNames) {
    if (/说明|instruction|readme/i.test(sheetName)) continue
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const source = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' })
    totalRows += source.length
    if (totalRows > MAX_IMPORT_ROWS) throw new Error(`表格数据不能超过 ${MAX_IMPORT_ROWS} 行。`)
    for (const row of source) {
      facts.push({
        id: crypto.randomUUID(),
        // 优先用“分组”列（旧版单表格式），否则用工作表名（新版分板块模板）
        group: text(row, ['分组', 'group']) || sheetName.trim() || '其他',
        item: Math.max(1, Number(text(row, ['条目', 'item', '编号'])) || 1),
        key: text(row, ['字段', '字段名', '一级分类', 'key', 'name']),
        value: text(row, ['值', '内容', 'value']),
        evidence: text(row, ['说明 / 原文依据', '原文依据', '来源', 'evidence']) || 'Excel 导入',
        source: 'profile' as const,
        updatedAt: new Date().toISOString()
      })
    }
  }
  const valid = facts.filter(fact => fact.key && fact.value && !(isSensitiveField(fact.key) && fact.value.includes('•')))
  if (!valid.length) throw new Error('没有识别到有效数据。请使用模板格式（每个板块一个工作表，含“条目、字段、值”列）。')
  return valid
}

/** Merge an imported profile without duplicating fields or deleting unrelated data. */
export function mergeImportedProfileFacts(existing: Fact[], imported: Fact[]): ProfileImportMergeResult {
  // 统一走知识库合并入口（features/rag/knowledge）：Excel 导入、简历提取、
  // 网页学习三条通道共用同一套 (板块, 条目, 字段) 合并规则。
  return mergeIntoKnowledge(existing, imported)
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
