// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanPage } from '../../src/features/autofill/scan/collector'

const originalRects = Element.prototype.getClientRects

beforeEach(() => {
  Element.prototype.getClientRects = function () {
    return { length: 1, item: () => ({}) as DOMRect } as unknown as DOMRectList
  }
})

afterEach(() => {
  Element.prototype.getClientRects = originalRects
  document.body.innerHTML = ''
})

describe('选择控件结构簇', () => {
  it('最近共同容器内的多个选择控件共享结构簇', () => {
    document.body.innerHTML = `
      <div class="compound-row">
        <label>组合信息</label>
        <select><option>请选择</option><option>A</option></select>
        <select><option>请选择</option><option>B</option></select>
      </div>
      <div><select><option>请选择</option><option>C</option></select></div>`
    const fields = scanPage().fields.filter(field => ['select', 'cascade', 'combobox'].includes(field.kind))
    expect(fields).toHaveLength(3)
    expect(fields[0].controlClusterId).toBeTruthy()
    expect(fields[1].controlClusterId).toBe(fields[0].controlClusterId)
    expect(fields[2].controlClusterId).toBeUndefined()
  })
})
