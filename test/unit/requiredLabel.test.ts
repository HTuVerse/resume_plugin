import { describe, expect, it } from 'vitest'
import { questionLabel, resolveLabel } from '../../src/features/autofill/scan/labelResolver'

describe('前置必填符标签', () => {
  it('label[for] 的半角/全角前置必填符会在扫描阶段剥离', () => {
    document.body.innerHTML = `
      <label for="name"><span class="required">＊</span> 亲属姓名：</label>
      <input id="name" required>
    `
    expect(resolveLabel(document.querySelector('input')!)).toEqual({ text: '亲属姓名', source: 'for' })
  })

  it('选择题容器中的前置必填符会被剥离', () => {
    document.body.innerHTML = `
      <div class="form-item">
        <div class="label"><span>*</span> 亲属性别</div>
        <div role="radiogroup"><label><input type="radio" name="sex">男</label></div>
      </div>
    `
    expect(questionLabel(document.querySelector('input')!)).toEqual({ text: '亲属性别', source: 'container' })
  })
})
