import { normalize } from '../../../shared/normalize'

/**
 * 稳定字段指纹（F15），替换 `field-${index}` 位置 ID。
 *
 * 组成：结构路径 + 稳定属性 + 标签哈希 + 控件类型 + 重复段序号。
 * 易变 id（组件库自动生成）必须剔除，否则指纹每次渲染都变、站点规则永久失效。
 */

/** 已知的易变 id 模式：React/Ant/Element 自动 id、uuid、随机 hash。 */
const VOLATILE_ID = /^(rc_select_|rc-tabs-|el-id-|ant-|input-\d|radix-|:r[0-9a-z]+:?|[0-9a-f]{8}-[0-9a-f]{4})/i

export function isVolatileId(id: string): boolean {
  if (!id) return true
  if (VOLATILE_ID.test(id)) return true
  if (/^\d{6,}$/.test(id)) return true
  if (/[0-9a-f]{8,}$/i.test(id) && /\d/.test(id)) return true
  return false
}

/** FNV-1a 32 位哈希（同步、确定性；无需 crypto.subtle 的异步开销）。 */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 到最近 form（或 body）的结构路径，如 'form[1]/fieldset[0]/div[3]'。 */
export function structuralPath(element: HTMLElement): string {
  const segments: string[] = []
  let node: HTMLElement | null = element
  for (let depth = 0; node && depth < 12; depth += 1) {
    const parent: HTMLElement | null = node.parentElement
    const tag = node.tagName.toLowerCase()
    if (!parent) {
      segments.unshift(tag)
      break
    }
    const sameTag = Array.from(parent.children).filter(child => child.tagName === node!.tagName)
    segments.unshift(`${tag}[${sameTag.indexOf(node)}]`)
    if (tag === 'form' || tag === 'body') break
    node = parent
  }
  return segments.join('/')
}

export interface FingerprintInput {
  element: HTMLElement
  label: string
  kind: string
  repeatIndex?: number
}

/**
 * 生成字段指纹。保留可读前缀便于调试与评测标注，
 * 如 `姓名.text#1-a3f9c1`。
 */
export function fieldFingerprint(input: FingerprintInput): string {
  const { element, label, kind, repeatIndex } = input
  const name = element.getAttribute('name') || ''
  const id = element.id && !isVolatileId(element.id) ? element.id : ''
  const stableAttr = name || id
  const labelNorm = normalize(label)
  const material = [
    structuralPath(element),
    stableAttr,
    shortHash(labelNorm),
    kind,
    String(repeatIndex ?? 0)
  ].join('|')
  const readable = (labelNorm || stableAttr || kind).slice(0, 16)
  return `${readable}#${repeatIndex ?? 0}-${shortHash(material)}`
}
