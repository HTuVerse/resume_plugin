import type { Fact } from '../../domain/types'
import { sectionOfText } from '../ontology/sections'

/**
 * 优先级合并：「我的信息」覆盖简历中同槽位的字段。
 *
 * 旧版的 groupSlot / keySlot 词典已删除（R2）：区块归一迁入 ontology/sections，
 * 键名归一改用 slotRegistry（factToSlot），全项目单一数据源（F01）。
 */

/**
 * 知识库是唯一填充数据源：只返回「我的信息」。
 * resumeFacts 参数保留以兼容既有调用，不再混入结果
 * （简历识别结果需经用户核对后保存进知识库，不存在第二套数据）。
 */
export function mergeFactsByPriority(profileFacts: Fact[], _resumeFacts: Fact[] = []): Fact[] {
  return profileFacts.filter(fact => fact.value.trim()).map(fact => ({ ...fact, source: 'profile' as const }))
}

/** 面板分组展示用：Fact 的区块 ID。 */
export function factSection(fact: Fact): string {
  return sectionOfText(fact.group) || 'other'
}
