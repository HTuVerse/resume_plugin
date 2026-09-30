import { describe, expect, it } from 'vitest'
import type { FormField } from '../../src/domain/types'
import { pageSegmentItem } from '../../src/features/autofill/pageSegment'

function field(partial: Partial<FormField>): FormField {
  return {
    id: 'f', fingerprint: 'f', label: '项目描述', group: '项目经验', sectionId: 'project',
    placeholder: '', kind: 'textarea', options: [], current: '', required: false, maxLength: 0,
    slot: 'project.description', ...partial
  }
}

describe('pageSegmentItem', () => {
  it('扫描器没有识别段号时，按同槽位在页面的出现顺序分段', () => {
    const fields = [
      field({ id: 'description-1' }),
      field({ id: 'description-2' }),
      field({ id: 'description-3' })
    ]
    expect(fields.map(row => pageSegmentItem(row, fields))).toEqual([1, 2, 3])
  })

  it('多个字段各自按出现顺序对齐到同一段', () => {
    const fields = [
      field({ id: 'name-1', label: '项目名称', slot: 'project.name' }),
      field({ id: 'description-1' }),
      field({ id: 'name-2', label: '项目名称', slot: 'project.name' }),
      field({ id: 'description-2' })
    ]
    expect(fields.map(row => pageSegmentItem(row, fields))).toEqual([1, 1, 2, 2])
  })

  it('扫描器给出可靠段号时保留原段号', () => {
    const fields = [field({ id: 'description-2', item: 2 })]
    expect(pageSegmentItem(fields[0], fields)).toBe(2)
  })

  it('同名字段的显式段号碰撞时改用出现顺序去重', () => {
    const fields = [field({ id: 'description-1', item: 1 }), field({ id: 'description-2', item: 1 })]
    expect(fields.map(row => pageSegmentItem(row, fields))).toEqual([1, 2])
  })
})
