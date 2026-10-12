// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventElement, readClickedChoice, scanPage } from '../../src/features/autofill/scan/collector'
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

describe('中文标题和占位符', () => {
  it('标题在输入框外层时用中文，不用 basicSex 这类英文 name', () => {
    document.body.innerHTML = `
      <section>
        <h2>基本信息</h2>
        <div class="row"><div class="name">性别</div><div><div><input name="basicSex" placeholder="请选择" value="男"></div></div></div>
        <div class="row"><div class="name">生源地</div><div><div><input name="srcPlace" placeholder="选择或搜索生源（户籍）地" value="选择或搜索生源（户籍）地"></div></div></div>
        <div class="row"><div class="name">健康状况</div><div><input name="healthCondition" placeholder="健康状况" value="健康状况"></div></div>
      </section>`
    const fields = scanPage().fields
    const gender = fields.find(field => field.name === 'basicSex')
    const place = fields.find(field => field.name === 'srcPlace')
    const health = fields.find(field => field.name === 'healthCondition')
    expect(gender?.label).toBe('性别')
    expect(gender?.current).toBe('男')
    expect(gender?.item).toBeUndefined()
    expect(place?.label).toBe('生源地')
    expect(place?.current).toBe('')
    expect(health?.label).toBe('健康状况')
    expect(health?.current).toBe('')
  })

  it('字段名只写在 placeholder 里时取出标题，不把提示句当成已填值', () => {
    document.body.innerHTML = `
      <section>
        <h2>基本信息</h2>
        <input name="basicSex" placeholder="请选择性别" value="请选择性别">
        <input name="srcPlace" placeholder="选择或搜索生源（户籍）地" value="选择或搜索生源（户籍）地">
        <input name="healthCondition" placeholder="健康状况" value="健康状况">
        <input name="nation" placeholder="请选择民族" value="彝族">
      </section>`
    const fields = scanPage().fields
    expect(fields.find(field => field.name === 'basicSex')).toMatchObject({ label: '性别', current: '' })
    expect(fields.find(field => field.name === 'srcPlace')).toMatchObject({ label: '生源地', current: '' })
    expect(fields.find(field => field.name === 'healthCondition')).toMatchObject({ label: '健康状况', current: '' })
    expect(fields.find(field => field.name === 'nation')).toMatchObject({ label: '民族', current: '彝族' })
  })

  it('单选题目粘上全部选项时只保留题目', () => {
    document.body.innerHTML = `
      <div class="row">
        <div class="name">性别 男 女 性别男女</div>
        <label class="el-radio">男<input type="radio" name="gender" value="1"></label>
        <label class="el-radio">女<input type="radio" name="gender" value="2"></label>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.label).toBe('性别')
    expect(field?.options).toEqual(['男', '女'])
  })
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

  it('单选文字前面的方框不记进值，也能按「是」点中', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">是否全日制</label>
        <label>
          <span><input type="radio" name="fulltime" value="1"><i>口</i>是</span>
          <span><input type="radio" name="fulltime" value="0"><i>口</i>否</span>
        </label>
      </div>`
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'radio')
    expect(field?.options).toEqual(['是', '否'])
    const yes = document.querySelector<HTMLInputElement>('input[value="1"]')!
    yes.checked = true
    expect(scanPage().fields.find(item => item.kind === 'radio')?.current).toBe('是')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '否', intent: 'manual' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(document.querySelector<HTMLInputElement>('input[value="0"]')!.checked).toBe(true)
    expect(yes.checked).toBe(false)
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
  it('下拉选项带勾时仍按学历文字选中', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <select>
          <option value="">请选择</option>
          <option value="bachelor">✓本科</option>
          <option value="master">硕士</option>
        </select>
      </div>`
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'select')
    expect(field?.options).toEqual(['本科', '硕士'])
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '本科' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('bachelor')
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

  it('扫描遗留的已展开下拉不会被再次点击关闭，直接选择并回填', async () => {
    document.body.innerHTML = `
      <div class="el-form-item">
        <label class="el-form-item__label">学历</label>
        <div class="el-select"><div class="el-select__wrapper"><input readonly placeholder="请选择"></div></div>
      </div>
      <div class="el-select-dropdown" style="display:block">
        <li class="el-select-dropdown__item">本科</li>
        <li class="el-select-dropdown__item">硕士</li>
      </div>`
    const dropdown = document.querySelector<HTMLElement>('.el-select-dropdown')!
    const select = document.querySelector<HTMLElement>('.el-select')!
    let triggerClicks = 0
    select.addEventListener('click', () => {
      triggerClicks += 1
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none'
    })
    dropdown.querySelectorAll('li')[1].addEventListener('click', () => {
      const selected = document.createElement('span')
      selected.className = 'el-select__selected-item'
      selected.textContent = '硕士'
      select.append(selected)
      dropdown.style.display = 'none'
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')!
    const ref = scanned.refs.get(field.fingerprint)!
    const execution = await executeFill({ fieldId: field.id, value: '硕士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(triggerClicks).toBe(0)
    expect(document.querySelector('.el-select__selected-item')?.textContent).toBe('硕士')
  })

  it('open Shadow DOM 内的下拉浮层能够定位并回填', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <label>学历</label>
      <div class="el-select"><div class="el-select__wrapper"><input readonly placeholder="请选择"></div></div>`
    const select = shadow.querySelector<HTMLElement>('.el-select')!
    const dropdown = document.createElement('div')
    dropdown.className = 'el-select-dropdown'
    dropdown.innerHTML = `
      <div class="el-select-dropdown__item">本科</div>
      <div class="el-select-dropdown__item">硕士</div>`
    select.addEventListener('click', () => {
      if (!dropdown.isConnected) shadow.append(dropdown)
    })
    dropdown.querySelectorAll<HTMLElement>('.el-select-dropdown__item')[1].addEventListener('click', () => {
      const selected = document.createElement('span')
      selected.className = 'el-select__selected-item'
      selected.textContent = '硕士'
      select.append(selected)
      dropdown.remove()
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')!
    const ref = scanned.refs.get(field.fingerprint)!
    const execution = await executeFill({ fieldId: field.id, value: '硕士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(select.querySelector('.el-select__selected-item')?.textContent).toBe('硕士')
  })

  it('没有组件类名和 ARIA 的新浮层按渲染选项组兜底回填', async () => {
    document.body.innerHTML = `
      <label for="degree">学历</label>
      <div id="degree" role="combobox"><input readonly placeholder="请选择"></div>`
    const trigger = document.querySelector<HTMLElement>('#degree')!
    const input = trigger.querySelector<HTMLInputElement>('input')!
    trigger.addEventListener('click', () => {
      if (document.querySelector('[data-test-menu]')) return
      const popup = document.createElement('div')
      popup.dataset.testMenu = 'true'
      popup.style.position = 'absolute'
      popup.innerHTML = '<div>本科</div><div>硕士</div>'
      popup.children[1].addEventListener('click', () => {
        input.readOnly = false
        input.value = '硕士'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        popup.remove()
      })
      document.body.append(popup)
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')!
    const ref = scanned.refs.get(field.fingerprint)!
    const execution = await executeFill({ fieldId: field.id, value: '硕士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(input.value).toBe('硕士')
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

  it('父级不是 radiogroup 的 role=radio 仍识别并点选', async () => {
    document.body.innerHTML = `
      <div class="form-item">
        <span class="label">政治面貌</span>
        <div class="choices">
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

  it('自绘 radio-item 没有 input 时收成一道题', () => {
    document.body.innerHTML = `
      <div class="form-item">
        <span class="label">政治面貌</span>
        <div>
          <span class="radio-item">群众</span>
          <span class="radio-item">中共党员</span>
        </div>
      </div>`
    const field = scanPage().fields.find(item => item.kind === 'radio')
    expect(field?.label).toBe('政治面貌')
    expect(field?.options).toEqual(['群众', '中共党员'])
  })

  it('处理函数在外层选项上时，藏起来的 input 仍会被选中', async () => {
    document.body.innerHTML = `
      <div class="form-item">
        <div class="label">性别</div>
        <div class="van-radio-group">
          <div class="van-radio"><span>男</span><input type="radio" name="gender" value="1" style="display:none"></div>
          <div class="van-radio"><span>女</span><input type="radio" name="gender" value="2" style="display:none"></div>
        </div>
      </div>`
    const female = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]
    female.closest('.van-radio')?.addEventListener('click', () => { female.checked = true })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'radio')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '女' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(female.checked).toBe(true)
  })

  it('藏起来的 select 会点中旁边的列表项', async () => {
    document.body.innerHTML = `
      <div class="field">
        <span class="label">学历</span>
        <select style="display:none"><option>请选择</option><option>本科</option><option>硕士</option></select>
        <ul class="options"><li>本科</li><li>硕士</li></ul>
      </div>`
    const picked: string[] = []
    document.querySelectorAll('li').forEach(item => item.addEventListener('click', () => picked.push(item.textContent || '')))
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'select')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '硕士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(picked).toContain('硕士')
    expect((ref.element as HTMLSelectElement).value).toBe('硕士')
  })

  it('另一道题把公共祖先撑大时，仍读到第二个选项的文字', () => {
    document.body.innerHTML = `
      <form>
        <div class="form-item"><div class="label">性别</div>
          <label><span>男</span><input type="radio" name="gender" value="1"></label>
          <label><span>女</span><input type="radio" name="gender" value="2"></label>
        </div>
        <div class="form-item"><div class="label">学历</div>
          <label><span>本科</span><input type="radio" name="edu" value="1"></label>
          <label><span>硕士</span><input type="radio" name="edu" value="2"></label>
        </div>
      </form>`
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.label === '性别')
    const female = document.querySelector('input[name="gender"][value="2"]')?.previousElementSibling as HTMLElement
    const ref = scanned.refs.get(field!.fingerprint)!
    expect(readClickedChoice(female, ref)).toBe('女')
  })

  it('composedPath 里更靠里的节点当作点击目标', () => {
    const inner = document.createElement('span')
    const host = document.createElement('div')
    const event = new Event('click')
    Object.defineProperty(event, 'target', { value: host })
    event.composedPath = () => [inner, host]
    expect(eventElement(event)).toBe(inner)
  })

  it('点中上一级后列表换成下一级，再点中下一级', async () => {
    document.body.innerHTML = `
      <div class="box"><input readonly placeholder="请选择"></div>
      <div role="listbox" style="display:none">
        <div role="option">工学</div>
        <div role="option">理学</div>
      </div>`
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    const input = document.querySelector<HTMLInputElement>('input')!
    document.body.addEventListener('click', event => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('.box')) list.style.display = 'block'
    })
    list.addEventListener('click', event => {
      const text = event.target instanceof HTMLElement ? event.target.textContent?.trim() : ''
      if (text === '工学') list.innerHTML = '<div role="option">计算机</div><div role="option">软件</div>'
      if (text === '计算机') input.value = '工学 / 计算机'
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '工学/计算机' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(input.value).toBe('工学 / 计算机')
  })

  it('下一级出现在新的一批选项里才点', async () => {
    document.body.innerHTML = `
      <div class="box"><input readonly placeholder="请选择"></div>
      <div role="listbox" style="display:none"><div role="option">工学</div><div role="option">理学</div></div>`
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    const input = document.querySelector<HTMLInputElement>('input')!
    document.body.addEventListener('click', event => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('.box')) list.style.display = 'block'
    })
    list.addEventListener('click', event => {
      const text = event.target instanceof HTMLElement ? event.target.textContent?.trim() : ''
      if (text === '工学' && !list.querySelector('[data-next]')) {
        const next = document.createElement('div')
        next.dataset.next = 'yes'
        next.innerHTML = '<div role="option">计算机</div><div role="option">软件</div>'
        list.append(next)
      }
      if (text === '计算机') input.value = '工学 / 计算机'
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '工学/计算机' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(list.querySelector('[data-next]')).toBeTruthy()
    expect(input.value).toBe('工学 / 计算机')
  })

  it('Ant Design 多选识别为 multiselect，并读到已渲染选项', () => {
    document.body.innerHTML = `
      <label>技能</label>
      <div class="ant-select ant-select-multiple">
        <input />
        <div class="ant-select-item-option">英语</div>
        <div class="ant-select-item-option">日语</div>
      </div>`
    const field = scanPage().fields.find(item => item.label.includes('技能') || item.kind === 'multiselect')
    expect(field?.kind).toBe('multiselect')
    expect(field?.options).toEqual(expect.arrayContaining(['英语', '日语']))
  })

  it('完整路径单独成一项时只点一次', async () => {
    document.body.innerHTML = `
      <div class="box"><input readonly placeholder="请选择"></div>
      <div role="listbox" style="display:none"><div role="option">工学/计算机</div><div role="option">理学</div></div>`
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    const input = document.querySelector<HTMLInputElement>('input')!
    const clicks: string[] = []
    document.body.addEventListener('click', event => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('.box')) list.style.display = 'block'
    })
    list.addEventListener('click', event => {
      const text = event.target instanceof HTMLElement ? event.target.textContent?.trim() || '' : ''
      if (!text) return
      clicks.push(text)
      input.value = text
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.kind === 'combobox')
    const ref = scanned.refs.get(field!.fingerprint)!
    const execution = await executeFill({ fieldId: field!.id, value: '工学/计算机' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(clicks).toEqual(['工学/计算机'])
  })
})
