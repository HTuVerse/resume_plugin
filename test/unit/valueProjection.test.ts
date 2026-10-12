import { describe, expect, it } from 'vitest'
import { compareProjectedSequence, projectOptionFromValue } from '../../src/features/autofill/valueProjection'

describe('通用复合值投影', () => {
  it('从未分隔的知识原值中为当前控件选择唯一选项', () => {
    expect(projectOptionFromValue(['请选择', '江西', '广东'], '江西省吉安')).toMatchObject({ value: '江西', ambiguous: false })
    expect(projectOptionFromValue(['南昌', '吉安', '九江'], '江西省吉安')).toMatchObject({ value: '吉安', ambiguous: false })
  })

  it('多个同分候选时拒绝猜测', () => {
    expect(projectOptionFromValue(['江西', '吉安'], '江西吉安')).toMatchObject({ ambiguous: true })
  })

  it('页面有序局部投影不会覆盖更完整知识', () => {
    expect(compareProjectedSequence('江西省吉安', '江西 / 吉安')).toBe('compatible')
    expect(compareProjectedSequence('工学 / 计算机', '工学 / 电子信息')).toBe('different')
  })
})
