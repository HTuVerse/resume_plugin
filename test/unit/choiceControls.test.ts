// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClickedChoice, scanPage } from '../../src/features/autofill/scan/collector'
import { executeFill } from '../../src/features/autofill/write/writeMachine'

const originalRects = Element.prototype.getClientRects

beforeEach(() => {
  Element.prototype.getClientRects = function () {
    const style = getComputedStyle(this as Element)
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { length: 0, item: () => null } as unknown as DOMRectList
    }
    return { length: 1, item: () => ({}) as DOMRect } as unknown as DOMRectList
  }
})

afterEach(() => {
  Element.prototype.getClientRects = originalRects
  document.body.innerHTML = ''
})

describe('下拉框与单选的识别、填写', () => {
  it('藏起来的 radio 仍识别成一道题，并按选项写入', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">性别</label>
        <div class="el-radio-group">
          <label class="el-radio">男<input type="radio" name="gender" value="1" style="display:none"></label>
          <label class="el-radio">女<input type="radio" name="gender" value="2" style="display:none"></label>
        </div>
      </div>`
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'radio')
    expect(field?.label).toBe('性别')
    expect(field?.options).toEqual(['男', '女'])
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '女' }, () => ref)
    expect(execution.result.status).toBe('filled')
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    expect(radios[1].checked).toBe(true)
    expect(radios[0].checked).toBe(false)
  })

  it('是/否单选读取可见文字，不把 value 的 0、1 写进知识库', () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">是否服从调剂</label>
        <input type="radio" name="adjust" value="1" id="yes" checked>
        <label for="yes">是</label>
        <input type="radio" name="adjust" value="0" id="no">
        <label for="no">否</label>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.label).toBe('是否服从调剂')
    expect(field?.options).toEqual(['是', '否'])
    expect(field?.current).toBe('是')
  })

  it('包在标签里的下拉框只把题目当字段名，不把选项串进去', () => {
    document.body.innerHTML = '<label>学历<select><option>请选择</option><option>本科</option><option>硕士</option></select></label>'
    const field = scanPage().fields.find(item => item.kind === 'select')
    expect(field?.label).toBe('学历')
  })
  it('下拉搜索框里的半截文字不当成已选值', () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <div class="el-select is-focus">
          <input class="ant-select-selection-search-input" value="本">
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'combobox')
    expect(field?.current).toBe('')
  })
  it('已选中的下拉项用展示文字，不用搜索框', () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <div class="el-select">
          <input class="ant-select-selection-search-input" value="本">
          <span class="ant-select-selection-item" title="本科">本</span>
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'combobox')
    expect(field?.label).toBe('学历')
    expect(field?.current).toBe('本科')
  })

  it('同一张表单里的多组单选按 name 分开，不会并成一道题', () => {
    document.body.innerHTML = `
      <fieldset>
        <div class="el-form-item"><label class="el-form-item__label">性别</label>
          <label>男<input type="radio" name="gender" value="1"></label>
          <label>女<input type="radio" name="gender" value="2"></label>
        </div>
        <div class="el-form-item"><label class="el-form-item__label">是否服从调剂</label>
          <label>是<input type="radio" name="adjust" value="1"></label>
          <label>否<input type="radio" name="adjust" value="0"></label>
        </div>
      </fieldset>`
    const radios = scanPage().fields.filter(item => item.kind === 'radio')
    expect(radios.map(item => item.label)).toEqual(['性别', '是否服从调剂'])
    expect(radios.find(item => item.label === '性别')?.options).toEqual(['男', '女'])
  })

  it('组件库单选要点可见的圆点，藏起来的 input 自己收不到点击', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">性别</label>
        <div class="el-radio-group">
          <label class="el-radio">
            <span class="el-radio__input"><input type="radio" name="gender" value="1"><span class="el-radio__inner"></span></span>
            <span class="el-radio__label">男</span>
          </label>
          <label class="el-radio">
            <span class="el-radio__input"><input type="radio" name="gender" value="2"><span class="el-radio__inner"></span></span>
            <span class="el-radio__label">女</span>
          </label>
        </div>
      </div>`
    const female = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]
    const inner = female.parentElement?.querySelector('.el-radio__inner')
    female.addEventListener('click', event => event.preventDefault())
    inner?.addEventListener('click', () => { female.checked = true })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'radio')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '女' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(female.checked).toBe(true)
  })

  it('只读的日期输入仍会识别，并点开面板选择日期', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">毕业时间</label>
        <div class="ant-picker"><input readonly placeholder="请选择日期"></div>
      </div>
      <div class="ant-picker-dropdown" style="display:none">
        <div class="ant-picker-cell ant-picker-cell-in-view" title="2021-09-01"><div class="ant-picker-cell-inner">1</div></div>
      </div>`
    const input = document.querySelector<HTMLInputElement>('input')!
    const dropdown = document.querySelector<HTMLElement>('.ant-picker-dropdown')!
    const cell = dropdown.querySelector<HTMLElement>('[title="2021-09-01"]')!
    document.body.addEventListener('click', () => { dropdown.style.display = 'block' })
    input.addEventListener('input', () => { input.value = '' })
    cell.addEventListener('click', () => { input.value = '2021-09-01' })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.label === '毕业时间')
    expect(field?.kind).toBe('date')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '2021-09-01' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(input.value).toBe('2021-09-01')
  })

  it('下拉框打开后点中选项，而不是把文字写进搜索框', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <div class="el-select"><div class="el-select__wrapper"><input readonly placeholder="请选择"></div></div>
      </div>
      <div class="el-select-dropdown" style="display:none">
        <li class="el-select-dropdown__item">本科</li>
        <li class="el-select-dropdown__item">硕士</li>
      </div>`
    const dropdown = document.querySelector<HTMLElement>('.el-select-dropdown')!
    const input = document.querySelector<HTMLInputElement>('input')!
    document.body.addEventListener('click', event => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('.el-select')) dropdown.style.display = 'block'
    })
    dropdown.querySelectorAll('li')[1].addEventListener('click', () => {
      const selected = document.createElement('span')
      selected.className = 'el-select__selected-item'
      selected.title = '硕士'
      selected.textContent = '硕士'
      document.querySelector('.el-select')?.append(selected)
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')
    expect(field?.label).toBe('学历')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '硕士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(input.value).toBe('')
    expect(document.querySelector('.el-select__selected-item')?.textContent).toBe('硕士')
  })

  it('时间输入按 HH:mm 写入', async () => {
    document.body.innerHTML = '<input type="time">'
    const scanned = scanPage()
    const field = scanned.fields[0]
    expect(field.kind).toBe('date')
    const ref = scanned.refs.get(field.fingerprint)!
    const execution = await executeFill({ fieldId: field.id, value: '9:30' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect((ref.element as HTMLInputElement).value).toBe('09:30')
  })

  it('单选只改外层 checked 样式、原生输入仍是旧值时，读到新选项', () => {
    document.body.innerHTML = `
      <div class="form-item">
        <div class="label">性别</div>
        <div class="radio"><span>男</span><input type="radio" name="gender" value="1" checked></div>
        <div class="radio checked"><span>女</span><input type="radio" name="gender" value="2"></div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.current).toBe('女')
  })

  it('Arco 单选只带 checked 类时，读到可见文字', () => {
    document.body.innerHTML = `
      <div class="arco-form-item">
        <label class="arco-form-item-label">性别</label>
        <div class="arco-radio-group">
          <label class="arco-radio"><input type="radio" name="gender" value="M"><span class="arco-radio-text">男</span></label>
          <label class="arco-radio arco-radio-checked"><input type="radio" name="gender" value="F"><span class="arco-radio-text">女</span></label>
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.label).toBe('性别')
    expect(field?.current).toBe('女')
  })

  it('单选只给外层打了选中样式时，仍读到可见文字', () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">性别</label>
        <div class="el-radio-group">
          <label class="el-radio"><input type="radio" name="gender"><span class="el-radio__label">男</span></label>
          <label class="el-radio is-checked"><input type="radio" name="gender"><span class="el-radio__label">女</span></label>
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.current).toBe('女')
  })

  it('旧版下拉框用 selection-selected-value 展示已选项', () => {
    document.body.innerHTML = `
      <div class="ant-form-item">
        <label class="ant-form-item-label">学历</label>
        <div class="ant-select ant-select-open">
          <div class="ant-select-selection-selected-value" title="本科">本</div>
          <input class="ant-select-search__field" value="本">
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'combobox')
    expect(field?.current).toBe('本科')
  })

  it('下拉框还处于聚焦状态时，仍读到输入框里的已选项', () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <div class="el-select is-focused">
          <div class="el-select__wrapper is-focused"><input class="el-input__inner" value="硕士"></div>
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'combobox')
    expect(field?.current).toBe('硕士')
  })

  it('下拉框占位节点排在前面时，仍读到已选中的项', () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <div class="el-select">
          <span class="el-select__selected-item el-select__placeholder">请选择</span>
          <span class="el-select__selected-item" title="硕士">硕</span>
          <input readonly placeholder="请选择">
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'combobox')
    expect(field?.current).toBe('硕士')
  })

  it('选项文字单独带 selected、原生仍是旧值时，读到新选项', () => {
    document.body.innerHTML = `
      <div class="form-item">
        <div class="label">性别</div>
        <div class="gender">
          <span class="opt">男</span>
          <span class="opt selected">女</span>
          <input type="radio" name="gender" value="1" checked>
          <input type="radio" name="gender" value="2">
        </div>
      </div>`
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'radio')
    expect(field?.current).toBe('女')
    const female = document.querySelector<HTMLElement>('.opt.selected')!
    const ref = scanned.refs.get(field!.fingerprint)!
    expect(readClickedChoice(female, ref)).toBe('女')
  })

  it('TDesign 的 t-is-checked 读到可见文字', () => {
    document.body.innerHTML = `
      <div class="t-form__item">
        <label class="t-form__label">性别</label>
        <div class="t-radio-group">
          <label class="t-radio"><input type="radio" name="gender" value="M"><span>男</span></label>
          <label class="t-radio t-is-checked"><input type="radio" name="gender" value="F"><span>女</span></label>
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.current).toBe('女')
  })

  it('没有原生 input 的单选组可以识别并点选', async () => {
    document.body.innerHTML = `
      <div class="form-item">
        <span class="label">政治面貌</span>
        <div role="radiogroup">
          <div role="radio">群众</div>
          <div role="radio">中共党员</div>
        </div>
      </div>`
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.label === '政治面貌')
    expect(field?.kind).toBe('radio')
    expect(field?.options).toEqual(['群众', '中共党员'])
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '中共党员' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(document.querySelectorAll('[role="radio"]')[1].getAttribute('aria-checked')).toBe('true')
  })
})
