import { describe, expect, it } from 'vitest'
import { fillCandidates } from '../../src/features/autofill/write/writeMachine'
import { detectDateFormat, formatWithPattern, nextRecipe, priorValuesFor } from '../../src/features/autofill/write/fillRecipes'
import type { FillRecipe } from '../../src/domain/types'

describe('站点填法', () => {
  it('记下和档案不同的日期格式，下次优先用页面写法', () => {
    const recipe = nextRecipe(undefined, 'jobs.example', 'education.startDate', '2021-09', '2021/09')
    expect(recipe?.dateFormat).toBe('YYYY/MM')
    expect(priorValuesFor(recipe || undefined, '2021-09')).toEqual(['2021/09'])
    expect(formatWithPattern('2020-06-01', 'YYYY年MM月')).toBe('2020年06月')
  })
  it('档案格式本身不记成新配方', () => {
    expect(detectDateFormat('2021-09')).toBe('YYYY-MM')
    expect(nextRecipe(undefined, 'jobs.example', 'education.startDate', '2021-09', '2021-09')).toBeNull()
  })
  it('选项原文和档案值不同时记下来，并排在同义值前面', () => {
    const recipe = nextRecipe(undefined, 'jobs.example', 'personal.politicalStatus', '党员', '中共党员') as FillRecipe
    expect(recipe.options).toEqual([{ from: '党员', to: '中共党员' }])
    const values = fillCandidates({ fieldId: 'f', value: '党员', slot: 'personal.politicalStatus', priorValues: priorValuesFor(recipe, '党员') })
    expect(values[0]).toBe('中共党员')
    expect(values).toContain('党员')
  })
})
