// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FieldRef } from '../../src/features/autofill/scan/collector'
import { executeFill } from '../../src/features/autofill/write/writeMachine'
import { splitCascadeValue } from '../../src/features/autofill/write/recognizers'

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

describe('下拉按匹配度投影选中最匹配项', () => {
  it('原生下拉对不上整句时投影选中最匹配选项，并标记为待复核', async () => {
    document.body.innerHTML = '<select id="s"><option value="">请选择</option><option>江西</option><option>广东</option></select>'
    const select = document.querySelector<HTMLSelectElement>('#s')!
    const ref: FieldRef = { kind: 'select', element: select }
    const execution = await executeFill({ fieldId: 'f', value: '江西省吉安', valueMode: 'match-options' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(execution.result.needsReview).toBe(true)
    expect(select.value).toBe('江西')
  })

  it('精确命中时不标记待复核', async () => {
    document.body.innerHTML = '<select id="s2"><option value="">请选择</option><option>男</option><option>女</option></select>'
    const select = document.querySelector<HTMLSelectElement>('#s2')!
    const ref: FieldRef = { kind: 'select', element: select }
    const execution = await executeFill({ fieldId: 'g', value: '男', valueMode: 'match-options' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(execution.result.needsReview).toBeFalsy()
    expect(select.value).toBe('男')
  })
})

describe('级联值拆分', () => {
  it('连写行政区末级缺后缀也能拆出', () => {
    expect(splitCascadeValue('江西省吉安市永丰县')).toEqual(['江西省', '吉安市', '永丰县'])
    expect(splitCascadeValue('江西省吉安市永丰')).toEqual(['江西省', '吉安市', '永丰'])
  })

  it('单级值不拆', () => {
    expect(splitCascadeValue('北京市')).toEqual(['北京市'])
    expect(splitCascadeValue('计算机科学与技术')).toEqual(['计算机科学与技术'])
  })

  it('显式分隔符优先拆分', () => {
    expect(splitCascadeValue('江西 / 吉安 / 永丰')).toEqual(['江西', '吉安', '永丰'])
  })
})
