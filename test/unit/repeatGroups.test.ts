// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { detectRepeatGroup } from '../../src/features/autofill/scan/repeatGroups'

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
  it('非重复布局返回 null', () => {
    document.body.innerHTML = '<form><div><label>姓名</label><input /></div><div><label>邮箱</label><input type="email" /></div></form>'
    const input = document.querySelector('input')!
    expect(detectRepeatGroup(input)).toBeNull()
  })
})
