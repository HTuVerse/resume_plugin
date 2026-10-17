// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanPage } from '../../src/features/autofill/scan/collector'
import { classifyPageInput } from '../../src/features/rag/knowledge'

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

describe('带前置选择框的复合字段', () => {
  it.each([
    ['证件号码', '身份证', '362425200503120055'],
    ['手机号码', '+86', '13800138000']
  ])('不把前置选项 %s 的值归入后面的输入字段', (label, selected, typed) => {
    document.body.innerHTML = `
      <div class="ant-form-item">
        <div class="ant-form-item-label"><label>${label}</label></div>
        <div class="ant-form-item-control">
          <select><option>${selected}</option><option>其他</option></select>
          <input type="text" value="${typed}">
        </div>
      </div>`
    const fields = scanPage().fields
    const choice = fields.find(field => field.kind === 'select')!
    const input = fields.find(field => field.kind === 'text')!
    expect(fields).toHaveLength(2)
    expect(input.label).toBe(label)
    expect(classifyPageInput(input, typed)?.fact.value).toBe(typed)
    expect(classifyPageInput(choice, selected)).toBeNull()
  })

  it('自定义下拉也不能借用整行标签作为自己的知识库字段', () => {
    document.body.innerHTML = `
      <div class="ant-form-item">
        <div class="ant-form-item-label"><label>证件号码</label></div>
        <div class="ant-form-item-control">
          <div class="ant-select"><div class="ant-select-selector">
            <span class="ant-select-selection-item">身份证</span>
            <input role="combobox" readonly>
          </div></div>
          <input type="text" value="362425200503120055" maxlength="18">
        </div>
      </div>`
    const fields = scanPage().fields
    const choice = fields.find(field => field.kind === 'combobox')!
    const input = fields.find(field => field.kind === 'text')!
    expect(fields).toHaveLength(2)
    expect(choice.current).toBe('身份证')
    expect(classifyPageInput(choice, choice.current)).toBeNull()
    expect(input.label).toBe('证件号码')
  })

  it('下拉框有独立标签时保留其字段身份', () => {
    document.body.innerHTML = `
      <div class="ant-form-item">
        <div class="ant-form-item-label"><label>证件号码</label></div>
        <div class="ant-form-item-control">
          <label for="id-type">证件类型</label>
          <select id="id-type"><option>身份证</option><option>护照</option></select>
          <input type="text" value="362425200503120055">
        </div>
      </div>`
    const fields = scanPage().fields
    const choice = fields.find(field => field.kind === 'select')!
    const input = fields.find(field => field.kind === 'text')!
    expect(choice.label).toBe('证件类型')
    expect(input.label).toBe('证件号码')
    expect(classifyPageInput(choice, '护照')?.fact.key).toBe('证件类型')
  })

  it('独立 label[for] 在控件容器外时仍优先于整行标签', () => {
    document.body.innerHTML = `
      <div class="ant-form-item">
        <div class="ant-form-item-label"><label>证件号码</label></div>
        <label for="id-type">证件类型</label>
        <div class="ant-form-item-control">
          <select id="id-type"><option>身份证</option><option>护照</option></select>
          <input type="text" value="362425200503120055">
        </div>
      </div>`
    const fields = scanPage().fields
    const choice = fields.find(field => field.kind === 'select')!
    const input = fields.find(field => field.kind === 'text')!
    expect(choice.label).toBe('证件类型')
    expect(input.label).toBe('证件号码')
  })

  it('无组件库表单项时也不能把相邻 select 的选项文字当成输入框标签', () => {
    document.body.innerHTML = `
      <div class="compound-row">
        <label>证件号码</label>
        <select><option>身份证</option><option>护照</option></select>
        <input type="text" value="362425200503120055">
      </div>`
    const fields = scanPage().fields
    const choice = fields.find(field => field.kind === 'select')!
    const input = fields.find(field => field.kind === 'text')!
    expect(input.label).toBe('证件号码')
    expect(classifyPageInput(choice, choice.current)).toBeNull()
  })
})
