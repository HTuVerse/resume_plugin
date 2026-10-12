import { describe, expect, it } from 'vitest'
import type { FormField } from '../../src/domain/types'
import { factToSlot } from '../../src/features/autofill/match/factToSlot'
import { inferQualifiedField } from '../../src/features/ontology/recordIdentity'

function field(label: string): FormField {
  return {
    id: label, fingerprint: label, label, group: '家庭关系', sectionId: 'family', placeholder: '',
    kind: 'text', options: [], current: '', required: false, maxLength: 0
  }
}

describe('本体驱动的复合字段身份', () => {
  it('限定词加字段名解析成槽位和记录限定词', () => {
    expect(inferQualifiedField(field('父亲姓名'))).toEqual({ qualifier: '父亲', slot: 'family.name' })
    expect(inferQualifiedField(field('妈妈工作单位'))).toEqual({ qualifier: '母亲', slot: 'family.employer' })
  })

  it('只有限定词时使用板块配置的默认槽位', () => {
    expect(inferQualifiedField(field('爸爸'))).toEqual({ qualifier: '父亲', slot: 'family.name' })
  })

  it('档案侧与页面侧使用同一套复合标签解析', () => {
    expect(factToSlot({ group: '家庭关系', item: 1, key: '父亲姓名' }).slot).toBe('family.name')
    expect(factToSlot({ group: '家庭关系', item: 1, key: '爸爸' }).slot).toBe('family.name')
  })
})
