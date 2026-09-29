// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { FieldRef } from '../../src/features/autofill/scan/collector'
import { executeFill, undoRecord, valuesEquivalent } from '../../src/features/autofill/write/writeMachine'

describe('executeFill（F14 写入-回读状态机）', () => {
  it('原生文本：写入 → 回读确认 → filled + reasonCode ok', async () => {
    document.body.innerHTML = '<form><input name="name" /></form>'
    const ref: FieldRef = { kind: 'text', element: document.querySelector('input')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '张三' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(execution.result.reasonCode).toBe('ok')
    expect((ref.element as HTMLInputElement).value).toBe('张三')
    expect(execution.undo?.previous).toBe('')
  })
  it('已有值且未勾选覆盖 → skipped-existing', async () => {
    document.body.innerHTML = '<input value="原值" />'
    const ref: FieldRef = { kind: 'text', element: document.querySelector('input')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '新值' }, () => ref)
    expect(execution.result.status).toBe('skipped')
    expect(execution.result.reasonCode).toBe('skipped-existing')
    expect((ref.element as HTMLInputElement).value).toBe('原值')
  })
  it('原生 select 同义值命中（学士 → 本科选项）', async () => {
    document.body.innerHTML = '<select><option>请选择</option><option>本科</option><option>硕士</option></select>'
    const ref: FieldRef = { kind: 'select', element: document.querySelector('select')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '学士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect((ref.element as HTMLSelectElement).selectedOptions[0].text).toBe('本科')
  })
  it('选项集中无匹配 → failed + no-matching-option（不猜填）', async () => {
    // 首项用占位选项：原生 select 默认选中第一项，否则 PRECHECK 会判「已有值」跳过
    document.body.innerHTML = '<select><option>请选择</option><option>汉族</option><option>回族</option></select>'
    const ref: FieldRef = { kind: 'select', element: document.querySelector('select')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '不存在的选项' }, () => ref)
    expect(execution.result.status).toBe('failed')
    expect(execution.result.reasonCode).toBe('no-matching-option')
  })
  it('定位失败 → element-lost，不做猜测', async () => {
    const execution = await executeFill({ fieldId: 'fp-lost', value: 'x' }, () => undefined)
    expect(execution.result.status).toBe('failed')
    expect(execution.result.reasonCode).toBe('element-lost')
  })
  it('只读字段 → readonly，不重试', async () => {
    document.body.innerHTML = '<input readonly />'
    const ref: FieldRef = { kind: 'text', element: document.querySelector('input')! }
    const execution = await executeFill({ fieldId: 'fp1', value: 'x' }, () => ref)
    expect(execution.result.reasonCode).toBe('readonly')
    expect(execution.result.attempts).toBe(0)
  })
})

describe('undoRecord（F52 撤销）', () => {
  it('文本恢复原值', async () => {
    document.body.innerHTML = '<input value="旧值" />'
    const ref: FieldRef = { kind: 'text', element: document.querySelector('input')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '新值', overwrite: true }, () => ref)
    expect(execution.result.status).toBe('filled')
    const problem = await undoRecord(execution.undo!)
    expect(problem).toBeNull()
    expect((ref.element as HTMLInputElement).value).toBe('旧值')
  })
})

describe('valuesEquivalent（kind 感知回读比对）', () => {
  it('日期宽松比对', () => {
    const ref = { kind: 'date', element: document.createElement('input') } as FieldRef
    expect(valuesEquivalent(ref, '2023-05-04', '2023年5月4日')).toBe(true)
  })
  it('级联多级拼接比对', () => {
    const ref = { kind: 'cascade', element: document.createElement('div') } as FieldRef
    expect(valuesEquivalent(ref, '广东省 / 广州市', '广东省/广州市')).toBe(true)
    expect(valuesEquivalent(ref, '广东省', '广东省/广州市')).toBe(false)
  })
})
