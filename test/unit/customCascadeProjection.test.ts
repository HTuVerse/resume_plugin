// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FieldRef } from '../../src/features/autofill/scan/collector'
import { executeFill } from '../../src/features/autofill/write/writeMachine'

const originalRects = Element.prototype.getClientRects

beforeEach(() => {
  Element.prototype.getClientRects = function () {
    const style = getComputedStyle(this as Element)
    if (style.display === 'none' || style.visibility === 'hidden') return { length: 0, item: () => null } as unknown as DOMRectList
    return { length: 1, item: () => ({}) as DOMRect } as unknown as DOMRectList
  }
})

afterEach(() => {
  Element.prototype.getClientRects = originalRects
  document.body.innerHTML = ''
})

describe('通用单控件级联投影', () => {
  it('无需预先拆词即可按每一级真实选项完成选择', async () => {
    document.body.innerHTML = '<div id="trigger" class="ant-cascader"><span class="ant-select-selection-item"></span></div>'
    const trigger = document.querySelector<HTMLElement>('#trigger')!
    trigger.addEventListener('click', () => {
      if (document.querySelector('.ant-cascader-dropdown')) return
      const popup = document.createElement('div')
      popup.className = 'ant-cascader-dropdown'
      popup.innerHTML = '<ul><li class="ant-cascader-menu-item">江西</li><li class="ant-cascader-menu-item">广东</li></ul>'
      popup.addEventListener('click', event => {
        const target = event.target as HTMLElement
        if (target.textContent === '江西') {
          popup.innerHTML = '<ul><li class="ant-cascader-menu-item">南昌</li><li class="ant-cascader-menu-item">吉安</li></ul>'
        } else if (target.textContent === '吉安') {
          trigger.querySelector<HTMLElement>('.ant-select-selection-item')!.textContent = '江西 / 吉安'
          popup.remove()
        }
      })
      document.body.appendChild(popup)
    })
    const ref: FieldRef = { kind: 'cascade', element: trigger }
    const execution = await executeFill({ fieldId: 'cascade', value: '江西省吉安' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(trigger.textContent).toContain('江西 / 吉安')
  })
})
