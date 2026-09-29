import { shortHash, structuralPath } from './fingerprint'

/**
 * 重复段聚类（F06）：同构兄弟节点聚类，替换固定 class 白名单。
 *
 * 对每个控件自底向上取 ≤8 层祖先作为候选容器 C，
 * 在 C 的兄弟中找「同 tag、同 class 签名、控件数量相近、标签相似」的同构集，
 * |S| ≥ 2 即认定为重复实例。取满足条件的最内层 C。
 */

const MAX_ANCESTOR_DEPTH = 8
const LABEL_JACCARD_THRESHOLD = 0.6
/** 状态类（active/hover/error 等）不参与 class 签名。 */
const STATE_CLASS = /(^|-)(active|hover|focus|error|success|warning|disabled|checked|selected|open|expanded|collapsed|first|last|odd|even)($|-)/i

export interface RepeatGroupInfo {
  repeatGroupId: string
  /** 1 起始的段号。 */
  item: number
  /** 重复容器（用于「新增一段」按钮定位，F17）。 */
  container: HTMLElement
}

function classSignature(element: HTMLElement): string {
  return Array.from(element.classList)
    .filter(name => !STATE_CLASS.test(name))
    .sort()
    .join('.')
}

function controlCount(element: HTMLElement): number {
  return element.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]').length
}

function labelMultiset(element: HTMLElement): Map<string, number> {
  const set = new Map<string, number>()
  for (const label of Array.from(element.querySelectorAll('label,.ant-form-item-label,.el-form-item__label,.label'))) {
    const text = (label.textContent || '').replace(/\s+/g, '').slice(0, 40)
    if (!text) continue
    set.set(text, (set.get(text) || 0) + 1)
  }
  return set
}

function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (!a.size && !b.size) return 1
  let intersection = 0
  let union = 0
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const key of keys) {
    const countA = a.get(key) || 0
    const countB = b.get(key) || 0
    intersection += Math.min(countA, countB)
    union += Math.max(countA, countB)
  }
  return union ? intersection / union : 0
}

function isRepeatSibling(candidate: HTMLElement, reference: HTMLElement, referenceControls: number, referenceLabels: Map<string, number>): boolean {
  if (candidate === reference) return true
  if (candidate.tagName !== reference.tagName) return false
  if (classSignature(candidate) !== classSignature(reference)) return false
  if (Math.abs(controlCount(candidate) - referenceControls) > 1) return false
  return jaccard(labelMultiset(candidate), referenceLabels) >= LABEL_JACCARD_THRESHOLD
}

/**
 * 判定控件所属的重复段。取最内层满足条件的容器。
 * 非重复布局返回 null。
 */
export function detectRepeatGroup(element: HTMLElement): RepeatGroupInfo | null {
  let node: HTMLElement | null = element.parentElement
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth += 1, node = node.parentElement) {
    const parent = node.parentElement
    if (!parent || parent === document.documentElement) continue
    // 容器需要有一定体量（至少含 1 个控件），避免把单个输入框的包装误判为段
    const controls = controlCount(node)
    if (!controls) continue
    const labels = labelMultiset(node)
    const siblings = Array.from(parent.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && isRepeatSibling(child, node!, controls, labels))
    if (siblings.length >= 2) {
      const groupId = `${shortHash(structuralPath(parent))}-${shortHash(classSignature(node))}`
      return {
        repeatGroupId: groupId,
        item: siblings.indexOf(node) + 1,
        container: node
      }
    }
  }
  return null
}

/**
 * 定位重复段的「新增一段」按钮（F17）：在重复容器的父节点之后的兄弟中
 * 找文案匹配的按钮。找不到返回 null。
 */
export function findAddButton(container: HTMLElement): HTMLElement | null {
  const parent = container.parentElement
  if (!parent) return null
  const scope = parent.parentElement || parent
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button,[role="button"],a'))
  return candidates.find(button => {
    const text = (button.textContent || '').trim()
    return text.length < 20 && /新增|添加|增加|再加|\+/.test(text)
  }) || null
}
