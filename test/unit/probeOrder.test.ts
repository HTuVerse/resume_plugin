import { describe, expect, it } from 'vitest'
import type { FormField } from '../../src/domain/types'
import { orderedChoiceProbes } from '../../src/features/autofill/scan/probeOptions'

function field(partial: Partial<FormField>): FormField {
  return {
    id: partial.label || 'f', fingerprint: partial.label || 'f', label: '', group: '', placeholder: '',
    kind: 'combobox', options: [], current: '', required: false, maxLength: 0, ...partial
  }
}

describe('orderedChoiceProbes', () => {
  it('空的性别和学历排在普通下拉前面，同类保持原顺序', () => {
    const fields = [
      field({ label: '学校名称' }),
      field({ label: '性别' }),
      field({ label: '专业名称' }),
      field({ label: '最高学历' })
    ]
    expect(orderedChoiceProbes(fields).map(item => item.label)).toEqual(['性别', '最高学历', '学校名称', '专业名称'])
  })
})
