// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { clickAddForSection, clickAddNear, detectRepeatGroup, findAddButton } from '../../src/features/autofill/scan/repeatGroups'

function educationBlock(index: number): string {
  return `<div class="edu-block">
    <div><label>学校名称</label><input name="school_${index}" /></div>
    <div><label>专业名称</label><input name="major_${index}" /></div>
    <div><label>学历</label><select name="degree_${index}"><option>本科</option></select></div>
  </div>`
}

describe('detectRepeatGroup（F06 同构兄弟聚类）', () => {
  it('三段教育经历各自分到 1/2/3 段', () => {
    document.body.innerHTML = `<section>${educationBlock(0)}${educationBlock(1)}${educationBlock(2)}</section>`
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name^="school"]'))
    const groups = inputs.map(input => detectRepeatGroup(input))
    expect(groups[0]?.item).toBe(1)
    expect(groups[1]?.item).toBe(2)
    expect(groups[2]?.item).toBe(3)
    expect(new Set(groups.map(group => group?.repeatGroupId)).size).toBe(1)
  })
  it('状态类（active）不影响聚类', () => {
    document.body.innerHTML = `<section>
      <div class="edu-block active">${'<div><label>学校名称</label><input /></div><div><label>学历</label><input /></div>'}</div>
      <div class="edu-block">${'<div><label>学校名称</label><input /></div><div><label>学历</label><input /></div>'}</div>
    </section>`
    const inputs = Array.from(document.querySelectorAll('input'))
    expect(detectRepeatGroup(inputs[0] as HTMLElement)?.item).toBe(1)
    expect(detectRepeatGroup(inputs[2] as HTMLElement)?.item).toBe(2)
  })
  it('基本信息里上下排列的单行输入不是重复段', () => {
    document.body.innerHTML = `<section>
      <div class="row"><input name="basicSex" /></div>
      <div class="row"><input name="political" /></div>
      <div class="row"><input name="nation" /></div>
    </section>`
    const inputs = Array.from(document.querySelectorAll('input'))
    expect(detectRepeatGroup(inputs[0])).toBeNull()
    expect(detectRepeatGroup(inputs[2])).toBeNull()
  })
  it('同一段教育里的单选和学历不会被拆成多段', () => {
    document.body.innerHTML = `<section>
      <div class="edu-block">
        <div class="row"><label>学校名称</label><input name="school" /></div>
        <div class="row"><label>学历</label><select name="degree"></select><input type="hidden" /></div>
        <div class="row"><input type="radio" name="fulltime" value="1" /><input type="radio" name="fulltime" value="0" /></div>
        <div class="row"><input type="radio" name="recruit" value="1" /><input type="radio" name="recruit" value="0" /></div>
        <div class="row"><input type="radio" name="leader" value="1" /><input type="radio" name="leader" value="0" /></div>
      </div>
    </section>`
    const school = document.querySelector<HTMLElement>('input[name="school"]')!
    const degree = document.querySelector<HTMLElement>('select[name="degree"]')!
    const radios = Array.from(document.querySelectorAll<HTMLElement>('input[type="radio"]'))
    expect(detectRepeatGroup(school)).toBeNull()
    expect(detectRepeatGroup(degree)).toBeNull()
    for (const radio of radios) expect(detectRepeatGroup(radio)).toBeNull()
  })
  it('两段教育里的单选和学校算同一段', () => {
    const block = (index: number) => `<div class="edu-block">
      <div class="row"><label>学校名称</label><input name="school_${index}" /></div>
      <div class="row"><label>学历</label><select name="degree_${index}"></select></div>
      <div class="row"><input type="radio" name="full_${index}" value="1" /><input type="radio" name="full_${index}" value="0" /></div>
      <div class="row"><input type="radio" name="lead_${index}" value="1" /><input type="radio" name="lead_${index}" value="0" /></div>
    </div>`
    document.body.innerHTML = `<section>${block(1)}${block(2)}</section>`
    const school1 = document.querySelector<HTMLElement>('input[name="school_1"]')!
    const school2 = document.querySelector<HTMLElement>('input[name="school_2"]')!
    const radio1 = document.querySelector<HTMLElement>('input[name="full_1"]')!
    const radio2 = document.querySelector<HTMLElement>('input[name="lead_2"]')!
    expect(detectRepeatGroup(school1)?.item).toBe(1)
    expect(detectRepeatGroup(radio1)?.item).toBe(1)
    expect(detectRepeatGroup(radio1)?.repeatGroupId).toBe(detectRepeatGroup(school1)?.repeatGroupId)
    expect(detectRepeatGroup(school2)?.item).toBe(2)
    expect(detectRepeatGroup(radio2)?.item).toBe(2)
    expect(detectRepeatGroup(radio2)?.repeatGroupId).toBe(detectRepeatGroup(school2)?.repeatGroupId)
  })
  it('某一段缺少可选字段时仍识别为同一个重复集合', () => {
    document.body.innerHTML = `<section>
      <div class="edu-block"><div><label>学校名称</label><input name="school_1" /></div><div><label>学历</label><input name="degree_1" /></div></div>
      <div class="edu-block"><div><label>学校名称</label><input name="school_2" /></div></div>
    </section>`
    const first = document.querySelector<HTMLElement>('input[name="school_1"]')!
    const second = document.querySelector<HTMLElement>('input[name="school_2"]')!
    expect(detectRepeatGroup(first)?.item).toBe(1)
    expect(detectRepeatGroup(second)?.item).toBe(2)
    expect(detectRepeatGroup(first)?.repeatGroupId).toBe(detectRepeatGroup(second)?.repeatGroupId)
  })
  it('非重复布局返回 null', () => {
    document.body.innerHTML = '<form><div><label>姓名</label><input /></div><div><label>邮箱</label><input type="email" /></div></form>'
    const input = document.querySelector('input')!
    expect(detectRepeatGroup(input)).toBeNull()
  })
})

describe('findAddButton（只点新增一段）', () => {
  it('点教育经历后面的添加，不点块内的添加附件，也不点下一段的添加', () => {
    document.body.innerHTML = `<section>
      <h3>教育经历</h3>
      <div class="edu-block"><label>学校名称</label><input /><button type="button" id="file">添加附件</button></div>
      <button type="button" id="add-edu">添加教育经历</button>
      <h3>项目经验</h3>
      <div class="proj-block"><label>项目名称</label><input /></div>
      <button type="button" id="add-proj">添加项目</button>
    </section>`
    const block = document.querySelector<HTMLElement>('.edu-block')!
    const clicked: string[] = []
    for (const button of Array.from(document.querySelectorAll('button'))) {
      button.addEventListener('click', () => clicked.push(button.id))
    }
    expect(findAddButton(block)?.id).toBe('add-edu')
    expect(clickAddNear(block.querySelector('input')!)).toBe(true)
    expect(clicked).toEqual(['add-edu'])
  })
  it('教育段和实习段各有添加时，只点教育段自己的按钮', () => {
    const block = (klass: string, name: string) => `<div class="${klass}">
      <div><label>学校名称</label><input name="${name}" /></div>
      <div><label>专业名称</label><input /></div>
    </div>`
    document.body.innerHTML = `<section>
      <div class="note"><label>备注</label><input name="note" /></div>
      <button type="button" id="add-note">添加说明</button>
      ${block('edu-block', 'school_1')}${block('edu-block', 'school_2')}
      <button type="button" id="add-edu">添加教育经历</button>
      ${block('job-block', 'company_1')}${block('job-block', 'company_2')}
      <button type="button" id="add-job">添加实习经历</button>
    </section>`
    const clicked: string[] = []
    for (const button of Array.from(document.querySelectorAll('button'))) {
      button.addEventListener('click', () => clicked.push(button.id))
    }
    const school = document.querySelector<HTMLElement>('input[name="school_1"]')!
    expect(clickAddForSection([school])).toBe(true)
    expect(clicked).toEqual(['add-edu'])
  })
  it('后面只有添加附件时不点', () => {
    document.body.innerHTML = `<div class="edu-block"><label>学校名称</label><input /></div><button type="button" id="file">添加附件</button>`
    const block = document.querySelector<HTMLElement>('.edu-block')!
    expect(findAddButton(block)).toBeNull()
    expect(clickAddNear(block.querySelector('input')!)).toBe(false)
  })
})
