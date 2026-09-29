import { describe, expect, it } from 'vitest'
import type { Fact } from '../../src/domain/types'
import { alignFamilyItem, relationKey } from '../../src/features/autofill/familyAlign'

function fact(partial: Partial<Fact>): Fact {
  return { id: crypto.randomUUID(), group: '家庭关系', item: 1, key: '关系', value: '父亲', evidence: '', ...partial }
}

const family = [
  fact({ item: 1, key: '关系', value: '父亲' }),
  fact({ item: 1, key: '姓名', value: '张建国' }),
  fact({ item: 2, key: '关系', value: '母亲' }),
  fact({ item: 2, key: '姓名', value: '李秀兰' })
]

describe('家庭关系按称谓对齐', () => {
  it('爸爸和父亲是同一个人', () => {
    expect(relationKey('爸爸')).toBe('父亲')
    expect(relationKey('妈妈')).toBe('母亲')
  })
  it('页面第一段是妈妈时，写回知识库里的母亲，不覆盖父亲', () => {
    expect(alignFamilyItem(1, '妈妈', family)).toBe(2)
  })
  it('知识库没有这个称谓时新开一段', () => {
    expect(alignFamilyItem(1, '配偶', family)).toBe(3)
  })
  it('没有称谓时仍用页面段号', () => {
    expect(alignFamilyItem(2, '', family)).toBe(2)
  })
})
