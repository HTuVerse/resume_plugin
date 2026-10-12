import { describe, expect, it } from 'vitest'
import type { FormField } from '../../src/domain/types'
import { planValueBindings } from '../../src/features/autofill/bindingPlanner'

function field(id: string, kind: FormField['kind'] = 'select'): FormField {
  return {
    id, fingerprint: id, label: id, group: '同一表单项', placeholder: '', kind,
    options: [], current: '', required: false, maxLength: 0
  }
}

describe('通用控件组计划', () => {
  it('同一知识绑定的多个选择控件形成有序组', () => {
    const fields = [field('first'), field('second'), field('name', 'text')]
    const planned = planValueBindings(fields, item => item.kind === 'text' ? 'other' : 'fact-1')
    expect(planned.get('first')).toMatchObject({ index: 0, size: 2 })
    expect(planned.get('second')).toMatchObject({ index: 1, size: 2, previousFieldId: 'first' })
    expect(planned.has('name')).toBe(false)
  })

  it('同一结构簇只有一个已知知识时，未识别子控件继承组绑定', () => {
    const first = { ...field('first'), controlClusterId: 'cluster-1' }
    const second = { ...field('second'), controlClusterId: 'cluster-1' }
    const planned = planValueBindings([first, second], item => item.id === 'first' ? 'fact-1' : undefined)
    expect(planned.get('first')).toMatchObject({ factId: 'fact-1', index: 0 })
    expect(planned.get('second')).toMatchObject({ factId: 'fact-1', index: 1, previousFieldId: 'first' })
  })

  it('同一结构簇存在多个知识绑定时不合并', () => {
    const first = { ...field('first'), controlClusterId: 'cluster-1' }
    const second = { ...field('second'), controlClusterId: 'cluster-1' }
    const planned = planValueBindings([first, second], item => item.id === 'first' ? 'fact-1' : 'fact-2')
    expect(planned.size).toBe(0)
  })
})
