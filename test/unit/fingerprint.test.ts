// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fieldFingerprint, isVolatileId, structuralPath } from '../../src/features/autofill/scan/fingerprint'

function render(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.querySelector('input')!
}

describe('易变 id 剔除（F15）', () => {
  it('组件库自动 id 被判为易变', () => {
    expect(isVolatileId('rc_select_3')).toBe(true)
    expect(isVolatileId('el-id-1024-7')).toBe(true)
    expect(isVolatileId(':r1a:')).toBe(true)
    expect(isVolatileId('123456789')).toBe(true)
    expect(isVolatileId('3f2504e0-4f89-11d3')).toBe(true)
  })
  it('稳定 id 保留', () => {
    expect(isVolatileId('school-name')).toBe(false)
    expect(isVolatileId('userEmail')).toBe(false)
  })
})

describe('指纹稳定性', () => {
  const html = '<form><div><label>学校名称</label><input name="school" /></div></form>'
  it('同一 DOM 两次渲染指纹一致', () => {
    const first = fieldFingerprint({ element: render(html), label: '学校名称', kind: 'text', repeatIndex: 1 })
    const second = fieldFingerprint({ element: render(html), label: '学校名称', kind: 'text', repeatIndex: 1 })
    expect(first).toBe(second)
  })
  it('易变 id 变化不影响指纹', () => {
    const first = fieldFingerprint({ element: render('<form><input id="rc_select_1" name="school" /></form>'), label: '学校', kind: 'text' })
    const second = fieldFingerprint({ element: render('<form><input id="rc_select_9" name="school" /></form>'), label: '学校', kind: 'text' })
    expect(first).toBe(second)
  })
  it('不同段号产生不同指纹（防串段）', () => {
    const element = render(html)
    const first = fieldFingerprint({ element, label: '学校名称', kind: 'text', repeatIndex: 1 })
    const second = fieldFingerprint({ element, label: '学校名称', kind: 'text', repeatIndex: 2 })
    expect(first).not.toBe(second)
  })
})

describe('structuralPath', () => {
  it('到最近 form 的结构路径', () => {
    document.body.innerHTML = '<form><div></div><div><input /></div></form>'
    const input = document.querySelector('input')!
    expect(structuralPath(input)).toBe('form[0]/div[1]/input[0]')
  })
})
