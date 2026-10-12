import type { PlatformAdapter } from './contracts'

export const mokaAdapter: PlatformAdapter = {
  id: 'moka-web',
  family: 'moka',
  name: 'Moka 招聘',
  version: '2026.10',
  priority: 80,
  hostPatterns: [/(?:^|\.)(?:mokahr|moka)\.com$/i],
  pathPatterns: [/\/(?:m\/)?(?:apply|campus_apply|campus-recruitment|social-recruitment)(?:\/|$)/i],
  indicatorOnlyThreshold: 2,
  indicators: [
    '[class*="apply-field-"]',
    '[class*="sd-Select-container"]',
    '[class*="application-form"]',
    '[class*="questionnaire"]'
  ],
  selectors: {
    formItem: '[class*="apply-field-"],.ant-form-item,[class*="field-wrapper"],[class*="question-item"],[class*="schema-form-item"]',
    label: '[class*="title-"],.ant-form-item-label,label,[class*="field-label"],[class*="question-label"],[class*="question-title"]',
    section: '.ant-card-head-title,[class*="module-title"],[class*="questionnaire-title"],[class*="block-title"]',
    repeatItem: '[class*="resume-item"],[class*="experience-item"],[class*="record-item"],[class*="card-item"]',
    select: '[class*="sd-Select-container"],[class*="sd-Select-control"]',
    cascade: '[class*="sd-Cascader"]',
    date: '[class*="sd-DatePicker"],[class*="sd-MonthPicker"]',
    popup: '[class*="sd-Select-menu"],[class*="sd-Select-dropdown"],[class*="sd-DatePicker-panel"]',
    option: '[class*="sd-Select-option"]',
    selectionItem: '[class*="sd-Select-value"],[class*="sd-Select-singleValue"],[class*="sd-Select-multiValue"]',
    searchInput: '[class*="sd-Select-input"] input,[class*="sd-Select-container"] input[aria-autocomplete]',
    choiceWrapper: '[class*="sd-Radio"],[class*="sd-Checkbox"]',
    radioGroup: '[class*="sd-RadioGroup"]',
    checkboxGroup: '[class*="sd-CheckboxGroup"]',
    addButton: '[class*="add"],button,[role="button"]',
    range: '[class*="sd-DateRange"],[class*="date-range"]'
  },
  controls: [
    { selector: '[class*="sd-Select-container"]', type: 'select', confidence: 0.97, evidence: 'moka:sd-select', capabilities: { canClick: true, canSearch: true, canScroll: true } },
    { selector: '[class*="sd-Cascader"]', type: 'cascade', confidence: 0.97, evidence: 'moka:sd-cascader', capabilities: { canClick: true, canSearch: true, canScroll: true } },
    { selector: '[class*="sd-DatePicker"],[class*="sd-MonthPicker"]', type: 'date', confidence: 0.97, evidence: 'moka:sd-date', capabilities: { canClick: true, canUseKeyboard: true } }
  ],
  settleDelayMs: 260
}

