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
}

export const SECTIONS: SectionDef[] = [
  { id: 'personal', label: '基本信息', pattern: /基本信息|个人信息|个人资料|基础信息|basic|personal/i },
  { id: 'education', label: '教育经历', pattern: /教育|学历信息|学习经历|education/i },
  { id: 'intention', label: '求职意向', pattern: /求职意向|应聘意向|期望岗位|意向岗位|求职信息/ },
  { id: 'project', label: '项目经验', pattern: /项目经[验历]|项目背景|project/i },
  { id: 'internship', label: '实习经历', pattern: /实习|工作经[验历]|职业经历|任职经历|employment|internship|work/i },
  { id: 'campus', label: '社会实践 / 校内活动', pattern: /社会实践|校内活动|学生工作|社团|校园经历|在校经历/ },
  { id: 'award', label: '在校获奖荣誉', pattern: /奖励|荣誉|获奖|奖项|award|honor/i },
  { id: 'certificate', label: '证书', pattern: /证书|certificate/i },
  { id: 'skill', label: '技能 / 爱好', pattern: /技能|语言能力|爱好|特长|skill/i },
  { id: 'family', label: '家庭关系', pattern: /家庭|亲属|family/i },
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
