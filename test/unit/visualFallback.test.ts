// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FieldRef } from '../../src/features/autofill/scan/collector'
import { createVisualRecovery, warmupVisualAssist } from '../../src/features/autofill/write/visualFallback'
import type { FillExecution } from '../../src/features/autofill/write/writeMachine'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('视觉填写降级', () => {
  it('浏览器内 OCR 与视觉 AI 状态会在批量开始时预热', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ocrAvailable: true, aiAvailable: true, ok: true }) } })
    await expect(warmupVisualAssist()).resolves.toEqual({ ready: true, ocrAvailable: true, aiAvailable: true, error: undefined })
  })

  it('本地 OCR 未启动时保留 DOM 失败原因并给出明确提示', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ocrAvailable: false, aiAvailable: true, ok: false }) } })
    const element = document.createElement('div')
    document.body.append(element)
    const ref: FieldRef = { kind: 'combobox', element }
    const failed: FillExecution = {
      result: {
        fieldId: 'degree',
        status: 'failed',
        reasonCode: 'option-list-not-found',
        message: '无法定位该控件的选项浮层'
      }
    }
    const recovered = await createVisualRecovery()({ fieldId: 'degree', value: '硕士' }, failed, ref)
    expect(recovered?.result).toMatchObject({ status: 'failed', reasonCode: 'option-list-not-found' })
    expect(recovered?.result.message).toContain('浏览器内本地 OCR 未能启动')
  })

  it('未配置视觉 AI 时不会仅凭 OCR 坐标点击', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ocrAvailable: true, aiAvailable: false, ok: true }) } })
    const element = document.createElement('div')
    document.body.append(element)
    const failed: FillExecution = { result: { fieldId: 'degree', status: 'failed', reasonCode: 'option-list-not-found', message: '无法定位该控件的选项浮层' } }
    const recovered = await createVisualRecovery()({ fieldId: 'degree', value: '硕士' }, failed, { kind: 'combobox', element })
    expect(recovered?.result.status).toBe('failed')
    expect(recovered?.result.message).toContain('支持图片输入的视觉 AI')
  })
})
