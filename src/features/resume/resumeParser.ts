import type { Fact } from '../../domain/types'

export interface ParsedResumeText {
  text: string
  fileType: 'pdf' | 'docx' | 'txt'
}

function fileTypeOf(file: File): ParsedResumeText['fileType'] {
  if (file.type.includes('pdf') || /\.pdf$/i.test(file.name)) return 'pdf'
  if (file.type.includes('word') || /\.docx$/i.test(file.name)) return 'docx'
  if (file.type.includes('text') || /\.txt$/i.test(file.name)) return 'txt'
  throw new Error('仅支持 PDF、DOCX 和 TXT 文件。')
}

export async function extractResumeText(file: File): Promise<ParsedResumeText> {
  const fileType = fileTypeOf(file)
  if (fileType === 'txt') return { text: (await file.text()).replace(/\u0000/g, '').trim(), fileType }
  if (fileType === 'docx') {
    const mammothModule = await import('mammoth')
    const text = await mammothModule.default.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    return { text: text.value.replace(/\u0000/g, '').trim(), fileType }
  }
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.mjs?url')
  ])
  GlobalWorkerOptions.workerSrc = workerModule.default
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '))
  }
  return { text: pages.join('\n').replace(/\u0000/g, '').trim(), fileType }
}

function newFact(group: string, key: string, value: string, evidence = value): Fact {
  return { id: crypto.randomUUID(), group, item: 1, key, value: value.trim(), evidence: evidence.trim(), source: 'resume', confidence: 0.7, updatedAt: new Date().toISOString() }
}

export function extractFactsByRules(text: string): Fact[] {
  const facts: Fact[] = []
  const add = (group: string, key: string, value: string, evidence = value) => {
    if (value.trim() && !facts.some(fact => fact.key === key && fact.value === value.trim())) facts.push(newFact(group, key, value, evidence))
  }
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
  const phone = text.match(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/)?.[0]
  const link = text.match(/https?:\/\/[^\s，。；]+/i)?.[0]
  if (email) add('基本信息', '电子邮箱', email)
  if (phone) add('基本信息', '移动电话', phone)
  const nameLine = text.split(/\r?\n/).map(line => line.trim()).find(line => /^[\u4e00-\u9fa5]{2,4}$/.test(line))
  if (nameLine) add('基本信息', '姓名', nameLine)
  const keywords: Array<[string, RegExp]> = [
    ['教育经历', /(?:学校|大学|学院|学历|专业)[:：]?\s*(.{2,80})/i],
    ['实习经历', /(?:工作经历|实习经历|公司|单位|岗位)[:：]?\s*(.{2,120})/i],
    ['项目经验', /(?:项目经历|项目名称|项目)[:：]?\s*(.{2,120})/i],
    ['技能 / 爱好', /(?:技能|语言|爱好)[:：]?\s*(.{2,120})/i]
  ]
  for (const [group, pattern] of keywords) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const key = group === '教育经历' ? '专业课程' : group === '实习经历' ? '工作描述' : group === '项目经验' ? '项目描述' : '个人爱好'
      add(group, key, match[1], match[0])
    }
  }
  if (!facts.length) text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 4 && line.length <= 160).slice(0, 30)
    .forEach((line, index) => add('待确认', `简历内容 ${index + 1}`, line, line))
  return facts
}
