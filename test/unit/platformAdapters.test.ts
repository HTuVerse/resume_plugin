// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mokaFixture from '../fixtures/moka-application.html?raw'
import beisenFixture from '../fixtures/beisen-phoenix.html?raw'
import feishuFixture from '../fixtures/feishu-application.html?raw'
import { detectPlatform } from '../../src/features/autofill/platforms/registry'
import { scanPage } from '../../src/features/autofill/scan/collector'
import { clickAddNear } from '../../src/features/autofill/scan/repeatGroups'
import { executeFill } from '../../src/features/autofill/write/writeMachine'

const originalRects = Element.prototype.getClientRects
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  Element.prototype.getClientRects = function () {
    const style = getComputedStyle(this as Element)
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { length: 0, item: () => null } as unknown as DOMRectList
    }
    return { length: 1, item: () => ({}) as DOMRect } as unknown as DOMRectList
  }
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  Element.prototype.getClientRects = originalRects
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ATS 平台识别', () => {
  it('按 Moka 官方申请路径识别，即使申请表尚未渲染', () => {
    expect(detectPlatform(document, 'https://app.mokahr.com/campus_apply/acme/1#/job/2/apply')?.adapter.id).toBe('moka-web')
  })

  it('按租户域名区分北森和飞书', () => {
    expect(detectPlatform(document, 'https://acme.zhiye.com/personal/delivery')?.adapter.family).toBe('beisen')
    expect(detectPlatform(document, 'https://acme.jobs.feishu.cn/12345')?.adapter.id).toBe('feishu-jobs')
  })

  it('企业自定义域名只有命中足够强的 Phoenix 特征才启用', () => {
    document.body.innerHTML = '<div class="form-item--phoenix"></div><div class="phoenix-select"></div>'
    expect(detectPlatform(document, 'https://career.example.com/apply')?.adapter.id).toBe('beisen-phoenix')
    document.body.innerHTML = '<div class="form-item"></div>'
    expect(detectPlatform(document, 'https://career.example.com/apply')).toBeNull()
  })
})

describe('平台 fixture 扫描', () => {
  it('识别 Moka 哈希字段容器、sd-Select 和教育经历', () => {
    document.body.innerHTML = mokaFixture
    const output = scanPage()
    expect(output.fields.find(field => field.name === 'candidateName')).toMatchObject({ label: '姓名', platformId: 'moka-web' })
    expect(output.fields.find(field => field.label === '最高学历')).toMatchObject({ kind: 'combobox', platformId: 'moka-web', item: undefined })
    expect(output.fields.find(field => field.name === 'school')).toMatchObject({ sectionId: 'education', item: 1 })
  })

  it('识别北森 Phoenix 下拉、月份和重复经历段号', () => {
    document.body.innerHTML = beisenFixture
    const fields = scanPage().fields
    expect(fields.filter(field => field.label === '学校名称').map(field => field.item)).toEqual([1, 2])
    expect(fields.find(field => field.label === '学历')).toMatchObject({ kind: 'combobox', platformId: 'beisen-phoenix' })
    expect(fields.find(field => field.label === '毕业时间')).toMatchObject({ kind: 'date', platformId: 'beisen-phoenix' })
  })

  it('识别飞书 Formily 标签、稳定字段属性和级联控件', () => {
    document.body.innerHTML = feishuFixture
    const fields = scanPage().fields
    expect(fields.find(field => field.name === 'candidateName')).toMatchObject({ label: '姓名', platformId: 'feishu-jobs' })
    expect(fields.find(field => field.label === '最高学历')).toMatchObject({ kind: 'combobox' })
    expect(fields.find(field => field.label === '期望工作城市')).toMatchObject({ kind: 'cascade' })
    expect(fields.find(field => field.label === '最高学历')?.fingerprint).toContain('最高学历')
  })

  it('北森添加经历只点击新增按钮，不点击附件或提交', () => {
    document.body.innerHTML = beisenFixture
    const add = document.querySelector<HTMLElement>('.add-record')!
    const upload = document.querySelector<HTMLElement>('.upload-file')!
    const addClick = vi.spyOn(add, 'click')
    const uploadClick = vi.spyOn(upload, 'click')
    const school = document.querySelector<HTMLInputElement>('input[name="school_1"]')!
    expect(clickAddNear(school)).toBe(true)
    expect(addClick).toHaveBeenCalledTimes(1)
    expect(uploadClick).not.toHaveBeenCalled()
  })

  it('Moka sd-Select 通过平台弹层选项填写并完成回读', async () => {
    document.body.innerHTML = mokaFixture
    const select = document.querySelector<HTMLElement>('[class*="sd-Select-container"]')!
    const input = select.querySelector<HTMLInputElement>('input')!
    const dropdown = document.createElement('div')
    dropdown.className = 'sd-Select-menu-x92'
    dropdown.style.display = 'none'
    dropdown.innerHTML = '<div class="sd-Select-option-x92">本科</div><div class="sd-Select-option-x92">硕士</div>'
    document.body.append(dropdown)
    select.addEventListener('click', () => { dropdown.style.display = 'block' })
    dropdown.children[1].addEventListener('click', () => {
      const selected = document.createElement('span')
      selected.className = 'sd-Select-singleValue-x92'
      selected.textContent = '硕士'
      select.append(selected)
      dropdown.style.display = 'none'
    })
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.label === '最高学历')!
    const ref = scanned.refs.get(field.fingerprint)!
    const execution = await executeFill({ fieldId: field.id, value: '硕士' }, () => ref)
    expect(execution.result.status, JSON.stringify(execution.result)).toBe('filled')
    expect(input.value).toBe('')
    expect(select.textContent).toContain('硕士')
  })

  it('北森 Phoenix 月份控件可通过输入兜底并回读', async () => {
    document.body.innerHTML = beisenFixture
    const scanned = scanPage()
    const field = scanned.fields.find(item => item.label === '毕业时间')!
    const ref = scanned.refs.get(field.fingerprint)!
    const execution = await executeFill({ fieldId: field.id, value: '2025-06-01' }, () => ref)
    expect(execution.result.status).toBe('filled')
    expect(ref.element.querySelector<HTMLInputElement>('input')?.value).toBe('2025-06')
  })
})

