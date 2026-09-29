import { describe, expect, it } from 'vitest'
import { sectionHeadingOf } from '../../src/features/autofill/scan/collector'
import { aliasSectionCount } from '../../src/features/ontology/slotRegistry'

describe('页面板块标题', () => {
  it('标题在表单块前面、不是卡片子节点时也能读到', () => {
    document.body.innerHTML = `
      <div>
        <div class="block-name">实习经历</div>
        <div class="fields"><label>开始时间</label><input /></div>
      </div>`
    const input = document.querySelector('input')!
    expect(sectionHeadingOf(input)).toBe('实习经历')
  })
  it('更近的标题优先于外层标题', () => {
    document.body.innerHTML = `
      <div>
        <h2>基本信息</h2>
        <div>
          <h3>教育经历</h3>
          <div><input /></div>
        </div>
      </div>`
    const input = document.querySelector('input')!
    expect(sectionHeadingOf(input)).toBe('教育经历')
  })
  it('对不上已知板块的包装标题会继续往上找', () => {
    document.body.innerHTML = `
      <section>
        <h2>项目经验</h2>
        <div class="panel">
          <div class="title">请按要求填写</div>
          <input />
        </div>
      </section>`
    const input = document.querySelector('input')!
    expect(sectionHeadingOf(input)).toBe('项目经验')
  })
  it('开始时间同时属于多个板块，不能学成全局别名', () => {
    expect(aliasSectionCount('开始时间')).toBeGreaterThan(1)
    expect(aliasSectionCount('移动电话')).toBe(1)
  })
})
