import { isElementVisible, pollUntil } from './domUtils'

/**
 * 下拉浮层精确定位（F10，TECH_DESIGN §8.3）。
 *
 * 组件库通常把浮层挂到 body 下且关闭时只是隐藏、DOM 仍在，
 * 全文档 querySelectorAll 取选项会点中别的控件的选项——这类错误会被
 * 回读判为成功，是最优先要修掉的错填来源（R4）。
 *
 * 定位顺序（任一成功即锁定，全部失败返回 null）：
 *   1. aria-controls / aria-owns
 *   2. aria-activedescendant 指向节点的最近浮层祖先
 *   3. 点击窗口内的 DOM 变更观测（新插入或由隐藏转可见的浮层容器）
 *   4. 兜底：可见候选浮层中几何距离最近者；≥2 个等距候选则放弃，不猜
 */

const POPUP_SELECTOR = [
  '.ant-select-dropdown', '.ant-cascader-dropdown', '.ant-picker-dropdown',
  '.el-select-dropdown', '.el-cascader__dropdown', '.el-picker-panel', '.el-popper',
  '.arco-select-dropdown', '.n-base-select-menu', '.ivu-select-dropdown',
  '.semi-select-dropdown', '.t-select__dropdown',
  '[role="listbox"]', '[class*="dropdown"]', '[class*="popper"]', '[class*="popup"]'
].join(',')

export const OPTION_SELECTOR = [
  '[role="option"]:not([aria-disabled="true"])',
  '.ant-select-item-option:not(.ant-select-item-option-disabled)',
  '.el-select-dropdown__item:not(.is-disabled)',
  '.arco-select-option:not(.arco-select-option-disabled)',
  '.n-base-select-option',
  '.semi-select-option',
  '.t-select-option',
  '.ivu-select-item',
  '.time-select-item',
  'li:not([aria-disabled="true"])'
].join(',')

function isPopupCandidate(element: Element): element is HTMLElement {
  return element instanceof HTMLElement
    && !element.closest('[data-resume-assistant]')
    && element.matches(POPUP_SELECTOR)
}

function popupAncestor(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>(POPUP_SELECTOR)
}

function byAria(trigger: HTMLElement): HTMLElement | null {
  const root = trigger.getRootNode() as Document | ShadowRoot
  const owns = trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns')
    || trigger.querySelector('[aria-controls],[aria-owns]')?.getAttribute('aria-controls')
    || trigger.querySelector('[aria-owns]')?.getAttribute('aria-owns')
  if (owns) {
    const target = root.getElementById?.(owns) || document.getElementById(owns)
    if (target && isElementVisible(target)) {
      return popupAncestor(target) || target
    }
  }
  const active = trigger.getAttribute('aria-activedescendant')
    || trigger.querySelector('[aria-activedescendant]')?.getAttribute('aria-activedescendant')
  if (active) {
    const descendant = root.getElementById?.(active) || document.getElementById(active)
    if (descendant) {
      const popup = popupAncestor(descendant)
      if (popup && isElementVisible(popup)) return popup
    }
  }
  return null
}

export interface PopupWatch {
  /** 在触发展开动作后调用，轮询定位浮层。 */
  locate(timeoutMs?: number): Promise<HTMLElement | null>
  dispose(): void
}

/**
 * 在展开浮层前调用：挂 MutationObserver 监听 body 子树，
 * 记录点击后新插入或由隐藏转可见的浮层容器。
 */
export function watchForPopup(trigger: HTMLElement): PopupWatch {
  const appeared = new Set<HTMLElement>()
  const visibleBefore = new Set<HTMLElement>(
    Array.from(document.querySelectorAll<HTMLElement>(POPUP_SELECTOR)).filter(isElementVisible)
  )
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue
        if (isPopupCandidate(node)) appeared.add(node)
        for (const popup of Array.from(node.querySelectorAll<HTMLElement>(POPUP_SELECTOR))) appeared.add(popup)
      }
      if (record.type === 'attributes' && record.target instanceof HTMLElement && isPopupCandidate(record.target)) {
        appeared.add(record.target)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })

  const locate = async (timeoutMs = 1500): Promise<HTMLElement | null> => {
    const found = await pollUntil<HTMLElement | null>(() => {
      // 1/2. aria 定位（最可靠）
      const ariaPopup = byAria(trigger)
      if (ariaPopup) return ariaPopup
      // 3. 变更观测：点击后新出现/转可见的浮层
      const observed = Array.from(appeared).filter(popup => popup.isConnected && isElementVisible(popup) && !visibleBefore.has(popup))
      const opened = Array.from(document.querySelectorAll<HTMLElement>(POPUP_SELECTOR))
        .filter(popup => isElementVisible(popup) && !visibleBefore.has(popup))
      const fresh = opened.length ? opened : observed
      if (fresh.length === 1) return fresh[0]
      if (fresh.length > 1) {
        // 嵌套容器（外层 popper + 内层 dropdown）：取最内层
        const innermost = fresh.filter(popup => !fresh.some(other => other !== popup && popup.contains(other)))
        if (innermost.length === 1) return innermost[0]
      }
      return null
    }, timeoutMs)
    if (found) return found

    // 4. 几何兜底：可见候选中取距触发元素最近者；等距 ≥2 个则放弃
    const rect = trigger.getBoundingClientRect()
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(POPUP_SELECTOR))
      .filter(popup => isElementVisible(popup) && popup.querySelector(OPTION_SELECTOR))
      .map(popup => {
        const popupRect = popup.getBoundingClientRect()
        const dx = Math.max(rect.left - popupRect.right, popupRect.left - rect.right, 0)
        const dy = Math.max(rect.top - popupRect.bottom, popupRect.top - rect.bottom, 0)
        return { popup, distance: Math.hypot(dx, dy) }
      })
      .sort((a, b) => a.distance - b.distance)
    if (!candidates.length) return null
    if (candidates.length > 1 && Math.abs(candidates[0].distance - candidates[1].distance) < 8) return null
    return candidates[0].popup
  }

  return { locate, dispose: () => observer.disconnect() }
}

/** 在已锁定的浮层内取可见选项（作用域收紧，禁止全局查询）。 */
export function popupOptions(popup: HTMLElement): HTMLElement[] {
  const all = Array.from(popup.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(isElementVisible)
  // li 兜底选择器可能命中嵌套结构，去掉包含其他选项的外层节点
  return all.filter(option => !all.some(other => other !== option && option.contains(other)))
}
