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
  return element.querySelectorAll('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"],[contenteditable="true"]').length
}

function listedControls(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"],[role="radio"],[role="checkbox"],[contenteditable="true"]'))
    .filter(node => !(node instanceof HTMLInputElement && ['hidden', 'file', 'button', 'submit', 'reset', 'image'].includes(node.type)))
}

function isChoiceControl(node: HTMLElement): boolean {
  if (node instanceof HTMLInputElement) return node.type === 'radio' || node.type === 'checkbox'
  const role = node.getAttribute('role')
  return role === 'radio' || role === 'checkbox'
}

/** 这一层只包着一道题（一个输入，或一组单选），不是一段经历。 */
function isSingleQuestion(element: HTMLElement): boolean {
  const controls = listedControls(element)
  if (!controls.length) return true
  if (controls.every(isChoiceControl)) return true
  return controls.length < 2 && labelMultiset(element).size < 2
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
  const candidateLabels = labelMultiset(candidate)
  // 行内没有标签、又只有一个控件时，是表单的上下两行，不是重复经历。
  if (!referenceLabels.size && !candidateLabels.size && referenceControls < 2) return false
  return jaccard(candidateLabels, referenceLabels) >= LABEL_JACCARD_THRESHOLD
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
    // 一组单选或单独一行不是重复经历，继续往外找整段
    if (isSingleQuestion(node)) continue
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

const ADD_ROW_TEXT = /新增|添加|增加|再加|\+/
/** 附件、上传一类按钮不是「再加一段经历」。 */
const NOT_ROW_TEXT = /附件|上传|文件|图片|照片|头像|简历|作品|链接|账号|好友|标签|备注/

/** 按钮文案是在重复段后面再加一段，而不是添加附件或别的操作。 */
export function isRepeatAddButton(button: HTMLElement): boolean {
  if (button.closest('[data-resume-assistant]')) return false
  if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return false
  const text = (button.textContent || '').replace(/\s+/g, '')
  if (!text || text.length >= 20) return false
  if (NOT_ROW_TEXT.test(text)) return false
  return ADD_ROW_TEXT.test(text)
}

function buttonIn(node: HTMLElement): HTMLElement | null {
  if (node.matches('button,[role="button"],a') && isRepeatAddButton(node)) return node
  return Array.from(node.querySelectorAll<HTMLElement>('button,[role="button"],a')).find(isRepeatAddButton) || null
}

/**
 * 定位重复段的「新增一段」按钮（F17）。
 * 只看容器后面的兄弟，以及容器父节点后面的兄弟，不在整页里乱点「添加」。
 */
export function findAddButton(container: HTMLElement): HTMLElement | null {
  let sibling = container.nextElementSibling
  for (let index = 0; sibling && index < 4; index += 1, sibling = sibling.nextElementSibling) {
    if (!(sibling instanceof HTMLElement) || container.contains(sibling)) continue
    const hit = buttonIn(sibling)
    if (hit) return hit
  }
  const parent = container.parentElement
  if (!parent) return null
  let next = parent.nextElementSibling
  for (let index = 0; next && index < 4; index += 1, next = next.nextElementSibling) {
    if (!(next instanceof HTMLElement)) continue
    const hit = buttonIn(next)
    if (hit && !container.contains(hit)) return hit
  }
  return null
}

/**
 * 点这些控件所属重复段后面的「添加」。
 * 同一页有多段时，不用板块里第一个字段往上乱找。
 */
export function clickAddForSection(elements: HTMLElement[]): boolean {
  const seen = new Set<string>()
  for (const element of elements) {
    if (!element.isConnected) continue
    const group = detectRepeatGroup(element)
    if (!group || seen.has(group.repeatGroupId)) continue
    seen.add(group.repeatGroupId)
    const button = findAddButton(group.container)
    if (!button) continue
    button.click()
    return true
  }
  return false
}

/** 从控件往上找最近的「新增一段」按钮并点击。点到返回 true。 */
export function clickAddNear(element: HTMLElement): boolean {
  let node: HTMLElement | null = element
  for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
    const button = findAddButton(node)
    if (!button) continue
    button.click()
    return true
  }
  return false
}
