import type { SectionId } from '../../domain/slots'

/**
 * 区块定义与判定（F01/F06）。
 * 原 factPriority.groupSlot 的逻辑迁入此处，页面侧与档案侧共用同一份判定。
 */

export interface SectionDef {
  id: SectionId
  /** 中文规范名（生成 AI schema、面板展示用）。 */
  label: string
  pattern: RegExp
  /** 可重复板块的记录身份定义。槽位顺序即匹配优先级。 */
  recordIdentity?: {
    anchorSlots: string[]
    discriminatorSlots?: string[]
    /** 标签本身携带记录主体时的数据驱动解析规则。 */
    qualifiers?: Array<{ canonical: string; aliases: string[] }>
    qualifierSlot?: string
    /** 标签只有限定词而没有字段名时默认表示的槽位。 */
    implicitQualifiedSlot?: string
  }
}

export const SECTIONS: SectionDef[] = [
  { id: 'personal', label: '基本信息', pattern: /基本信息|个人信息|个人资料|基础信息|basic|personal/i },
  { id: 'education', label: '教育经历', pattern: /教育|学历信息|学习经历|education/i,
    recordIdentity: { anchorSlots: ['education.school'], discriminatorSlots: ['education.endDate', 'education.startDate'] } },
  { id: 'intention', label: '求职意向', pattern: /求职意向|应聘意向|期望岗位|意向岗位|求职信息/ },
  { id: 'project', label: '项目经验', pattern: /项目经[验历]|项目背景|project/i,
    recordIdentity: { anchorSlots: ['project.name'], discriminatorSlots: ['project.endDate', 'project.startDate'] } },
  { id: 'internship', label: '实习经历', pattern: /实习|internship/i,
    recordIdentity: { anchorSlots: ['internship.company'], discriminatorSlots: ['internship.endDate', 'internship.startDate'] } },
  { id: 'work', label: '工作经历', pattern: /工作经[验历]|职业经历|任职经历|全职工作|employment/i,
    recordIdentity: { anchorSlots: ['work.company'], discriminatorSlots: ['work.endDate', 'work.startDate'] } },
  { id: 'campus', label: '社会实践 / 校内活动', pattern: /社会实践|校内活动|学生工作|社团|校园经历|在校经历/,
    recordIdentity: { anchorSlots: ['campus.name'], discriminatorSlots: ['campus.endDate', 'campus.startDate'] } },
  { id: 'award', label: '在校获奖荣誉', pattern: /奖励|荣誉|获奖|奖项|award|honor/i,
    recordIdentity: { anchorSlots: ['award.name'], discriminatorSlots: ['award.date'] } },
  { id: 'certificate', label: '证书', pattern: /证书|certificate/i,
    recordIdentity: { anchorSlots: ['certificate.name'], discriminatorSlots: ['certificate.date'] } },
  { id: 'skill', label: '技能 / 爱好', pattern: /技能|语言能力|爱好|特长|skill/i },
  { id: 'family', label: '家庭关系', pattern: /家庭|亲属|family/i,
    recordIdentity: {
      anchorSlots: ['family.relation'],
      qualifierSlot: 'family.relation',
      implicitQualifiedSlot: 'family.name',
      qualifiers: [
        { canonical: '父亲', aliases: ['父亲', '爸爸', '老爸', '家父'] },
        { canonical: '母亲', aliases: ['母亲', '妈妈', '老妈', '家母'] },
        { canonical: '配偶', aliases: ['配偶', '丈夫', '妻子', '老公', '老婆'] },
        { canonical: '兄弟', aliases: ['兄弟', '哥哥', '弟弟'] },
        { canonical: '姐妹', aliases: ['姐妹', '姐姐', '妹妹'] },
        { canonical: '子女', aliases: ['子女', '儿子', '女儿'] }
      ]
    }
  },
  { id: 'summary', label: '自我评价', pattern: /自我评价|自我介绍|个人总结|个人评价|开放文本|summary/i }
]

/** 页面区块标题 / 档案分组文本 → 区块 ID。无法判定时返回空串。 */
export function sectionOfText(text: string): SectionId | '' {
  const value = String(text || '').trim()
  if (!value) return ''
  return SECTIONS.find(section => section.pattern.test(value))?.id || ''
}

export function sectionLabel(id: SectionId): string {
  return SECTIONS.find(section => section.id === id)?.label || '其他'
}

export function sectionById(id: string | undefined): SectionDef | undefined {
  return SECTIONS.find(section => section.id === id)
}

/** 从标签或段标题中提取规范记录限定词；规则完全来自板块本体。 */
export function recordQualifierOf(sectionId: string | undefined, text: string): string {
  const identity = sectionById(sectionId)?.recordIdentity
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact || !identity?.qualifiers?.length) return ''
  for (const group of identity.qualifiers) {
    if (group.aliases.some(alias => compact.includes(alias.replace(/\s+/g, '')))) return group.canonical
  }
  return ''
}
