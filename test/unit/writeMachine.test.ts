// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { FieldRef } from '../../src/features/autofill/scan/collector'
import { executeFill, executeFillSequence, undoRecord, valuesEquivalent } from '../../src/features/autofill/write/writeMachine'
import { splitCascadeValue } from '../../src/features/autofill/write/recognizers'

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
  it('自动填写遇到已有值 → skipped-existing', async () => {
    document.body.innerHTML = '<input value="原值" />'
    const ref: FieldRef = { kind: 'text', element: document.querySelector('input')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '新值' }, () => ref)
    expect(execution.result.status).toBe('skipped')
    expect(execution.result.reasonCode).toBe('skipped-existing')
    expect((ref.element as HTMLInputElement).value).toBe('原值')
  })
  it('自动填写开始前用户刚输入的内容也会被保留', async () => {
    document.body.innerHTML = '<input />'
    const input = document.querySelector('input')!
    const ref: FieldRef = { kind: 'text', element: input }
    // 模拟识别完成后、批量写入开始前，用户手动输入。
    input.value = '用户手动填写'
    const execution = await executeFill({ fieldId: 'fp1', value: '档案值' }, () => ref)
    expect(execution.result).toMatchObject({
      status: 'skipped',
      reasonCode: 'skipped-existing',
      value: '用户手动填写',
      attempts: 0
    })
    expect(input.value).toBe('用户手动填写')
    expect(execution.undo).toBeUndefined()
  })
  it('明确的手动填写仍可覆盖，并保留撤销快照', async () => {
    document.body.innerHTML = '<input value="用户原值" />'
    const ref: FieldRef = { kind: 'text', element: document.querySelector('input')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '用户确认的新值', intent: 'manual' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect((ref.element as HTMLInputElement).value).toBe('用户确认的新值')
    expect(execution.undo?.previous).toBe('用户原值')
  })
  it('原生 select 同义值命中（学士 → 本科选项）', async () => {
    document.body.innerHTML = '<select><option>请选择</option><option>本科</option><option>硕士</option></select>'
    const ref: FieldRef = { kind: 'select', element: document.querySelector('select')! }
    const execution = await executeFill({ fieldId: 'fp1', value: '学士' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect((ref.element as HTMLSelectElement).selectedOptions[0].text).toBe('本科')
  })
  it('自动填写不会改写已有的下拉选择', async () => {
    document.body.innerHTML = '<select><option>请选择</option><option selected>本科</option><option>硕士</option></select>'
    const select = document.querySelector('select')!
    const ref: FieldRef = { kind: 'select', element: select }
    const execution = await executeFill({ fieldId: 'fp1', value: '硕士' }, () => ref)
    expect(execution.result).toMatchObject({ status: 'skipped', reasonCode: 'skipped-existing', value: '本科' })
    expect(select.selectedOptions[0].text).toBe('本科')
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
    const execution = await executeFill({ fieldId: 'fp1', value: '新值', intent: 'manual' }, () => ref)
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
    expect(valuesEquivalent(ref, '江西省 / 南昌市', '江西省南昌市')).toBe(true)
    expect(valuesEquivalent(ref, '江西省', '江西省南昌市')).toBe(false)
    expect(splitCascadeValue('江西 南昌')).toEqual(['江西', '南昌'])
    expect(splitCascadeValue('工学/计算机')).toEqual(['工学', '计算机'])
  })
  it('后一个下拉要等前一个写完才有选项', async () => {
    document.body.innerHTML = `
      <select id="child"><option>请选择</option></select>
      <select id="parent"><option>请选择</option><option>工学</option></select>`
    const parent = document.querySelector<HTMLSelectElement>('#parent')!
    const child = document.querySelector<HTMLSelectElement>('#child')!
    parent.addEventListener('change', () => {
      if (parent.selectedOptions[0]?.text !== '工学') return
      const option = document.createElement('option')
      option.text = '计算机'
      child.add(option)
    })
    const refs = new Map<string, FieldRef>([
      ['child', { kind: 'select', element: child }],
      ['parent', { kind: 'select', element: parent }]
    ])
    const executions = await executeFillSequence([
      { fieldId: 'child', value: '计算机' },
      { fieldId: 'parent', value: '工学' }
    ], id => refs.get(id))
    expect(executions.every(item => item.result.status === 'filled')).toBe(true)
    expect(parent.selectedOptions[0].text).toBe('工学')
    expect(child.selectedOptions[0].text).toBe('计算机')
  })

  it('同一未分隔原值可按动态选项投影到多个联动控件', async () => {
    document.body.innerHTML = `
      <select id="parent"><option>请选择</option><option>工学</option><option>理学</option></select>
      <select id="child"><option>请选择</option></select>`
    const parent = document.querySelector<HTMLSelectElement>('#parent')!
    const child = document.querySelector<HTMLSelectElement>('#child')!
    parent.addEventListener('change', () => {
      if (parent.selectedOptions[0]?.text !== '工学') return
      child.innerHTML = '<option>请选择</option><option>计算机</option><option>机械</option>'
    })
    const refs = new Map<string, FieldRef>([
      ['parent', { kind: 'select', element: parent }],
      ['child', { kind: 'select', element: child }]
    ])
    const executions = await executeFillSequence([
      { fieldId: 'parent', value: '工学计算机', valueMode: 'match-options', bindingGroupId: 'group-1' },
      { fieldId: 'child', value: '工学计算机', valueMode: 'match-options', bindingGroupId: 'group-1', dependsOn: ['parent'] }
    ], id => refs.get(id))
    expect(executions.every(item => item.result.status === 'filled')).toBe(true)
    expect(parent.selectedOptions[0].text).toBe('工学')
    expect(child.selectedOptions[0].text).toBe('计算机')
  })

  it('自定义下拉排在稳定字段之后，失败也不阻塞其它字段', async () => {
    document.body.innerHTML = `
      <div id="custom" role="combobox"></div>
      <input id="name" />`
    const custom = document.querySelector<HTMLElement>('#custom')!
    const name = document.querySelector<HTMLInputElement>('#name')!
    const refs = new Map<string, FieldRef>([
      ['custom', { kind: 'combobox', element: custom }],
      ['name', { kind: 'text', element: name }]
    ])
    custom.remove()
    const executions = await executeFillSequence([
      { fieldId: 'custom', value: '不存在的选项' },
      { fieldId: 'name', value: '张三' }
    ], id => refs.get(id))
    expect(name.value).toBe('张三')
    expect(executions[0].result.fieldId).toBe('name')
    expect(executions[0].result.status).toBe('filled')
    expect(executions[1].result).toMatchObject({ fieldId: 'custom', status: 'failed', reasonCode: 'element-lost' })
  })

  it('DOM 选项失败后调用视觉恢复通道，并采用已验证的恢复结果', async () => {
    document.body.innerHTML = '<select><option>请选择</option><option>本科</option></select>'
    const ref: FieldRef = { kind: 'select', element: document.querySelector('select')! }
    let recovered = false
    const executions = await executeFillSequence(
      [{ fieldId: 'degree', value: '硕士' }],
      () => ref,
      async (request, failed, receivedRef) => {
        recovered = true
        expect(request.fieldId).toBe('degree')
        expect(failed.result.reasonCode).toBe('no-matching-option')
        expect(receivedRef).toBe(ref)
        return { result: { ...failed.result, status: 'filled', reasonCode: 'ok', message: '视觉确认' } }
      }
    )
    expect(recovered).toBe(true)
    expect(executions[0].result).toMatchObject({ status: 'filled', reasonCode: 'ok', message: '视觉确认' })
  })
})
