import type { PlatformAdapter } from './contracts'

const beisenHosts = [
  /(?:^|\.)zhiye\.com$/i,
  /(?:^|\.)beisen\.com$/i,
  /(?:^|\.)italent\.cn$/i,
  /(?:^|\.)italentx\.(?:cn|com)$/i
]

export const beisenPhoenixAdapter: PlatformAdapter = {
  id: 'beisen-phoenix',
  family: 'beisen',
  name: '北森招聘 Phoenix',
  version: '2026.10',
  priority: 100,
  hostPatterns: beisenHosts,
  indicatorOnlyThreshold: 2,
  indicators: ['.form-item--phoenix', '.phoenix-select', '.phoenix-radio-group', '.ux-standard-form'],
  selectors: {
    formItem: '.form-item--phoenix,.form-item,.fields-col',
    label: '.form-item__text,.form-item__title,label',
    section: '.form-part-head,.form-part-head-new,.head-title,[class*="form-part-title"],[class*="module-title"]',
    repeatItem: '.ux-standard-form,[class*="record-item"],[class*="experience-item"],[class*="resume-item"]',
    select: '.phoenix-select,.phoenix-multiple-select,[class*="phoenix-select__control"]',
    cascade: '.phoenix-cascader,.phoenix-area-selector,[class*="phoenix-cascader"],[class*="region-selector"]',
    date: '.phoenix-date-picker,.phoenix-datepicker,.phoenix-month-picker,[class*="phoenix-date"]',
    popup: '.phoenix-select-dropdown,.phoenix-picker-panel,.phoenix-cascader-dropdown,[class*="phoenix-select-menu"]',
    option: '.phoenix-select-option,.phoenix-option,[class*="phoenix-cascader-option"]',
    selectionItem: '.phoenix-select__value,.phoenix-select-value,[class*="phoenix-tag"]',
    searchInput: '.phoenix-select input,.phoenix-cascader input',
    choiceWrapper: '.phoenix-radio,.phoenix-checkbox',
    radioGroup: '.phoenix-radio-group',
    checkboxGroup: '.phoenix-checkbox-group',
    addButton: '.phoenix-button,[class*="add"],button,[role="button"]',
    range: '.phoenix-date-range,[class*="phoenix-range"]'
  },
  controls: [
    { selector: '.phoenix-select,.phoenix-multiple-select', type: 'select', confidence: 0.98, evidence: 'beisen:phoenix-select', capabilities: { canClick: true, canSearch: true, canScroll: true } },
    { selector: '.phoenix-cascader,.phoenix-area-selector,[class*="phoenix-cascader"]', type: 'cascade', confidence: 0.98, evidence: 'beisen:phoenix-cascade', capabilities: { canClick: true, canSearch: true, canScroll: true } },
    { selector: '.phoenix-date-picker,.phoenix-datepicker,.phoenix-month-picker,[class*="phoenix-date"]', type: 'date', confidence: 0.98, evidence: 'beisen:phoenix-date', capabilities: { canClick: true, canUseKeyboard: true } }
  ],
  settleDelayMs: 320
}

export const beisenLegacyAdapter: PlatformAdapter = {
  id: 'beisen-legacy',
  family: 'beisen',
  name: '北森招聘旧版/iTalent',
  version: '2026.10',
  priority: 70,
  hostPatterns: beisenHosts,
  indicatorOnlyThreshold: 3,
  indicators: ['[class*="resume-form"]', '[class*="talent-form"]', '[class*="bs-"]', '.ant-form-item', '.el-form-item'],
  selectors: {
    formItem: '.ant-form-item,.el-form-item,[class*="resume-field"],[class*="field-row"]',
    label: '.ant-form-item-label,.el-form-item__label,label,[class*="field-label"]',
    section: '.ant-card-head-title,.el-card__header,[class*="block-title"],[class*="section-title"],[class*="module-title"]',
    repeatItem: '[class*="resume-item"],[class*="experience-item"],[class*="record-item"]',
    select: '.ant-select,.el-select,[class*="bs-select"]',
    cascade: '.ant-cascader,.el-cascader,[class*="bs-cascader"]',
    date: '.ant-picker,.el-date-editor,[class*="bs-date"]',
    popup: '.ant-select-dropdown,.el-select-dropdown,.ant-picker-dropdown,.el-picker-panel,[class*="bs-dropdown"]',
    option: '.ant-select-item-option,.el-select-dropdown__item,[class*="bs-option"]',
    selectionItem: '.ant-select-selection-item,.el-select__selected-item',
    searchInput: '.ant-select-selection-search-input,.el-select__input',
    choiceWrapper: '.ant-radio-wrapper,.ant-checkbox-wrapper,.el-radio,.el-checkbox,[class*="bs-radio"],[class*="bs-checkbox"]',
    radioGroup: '.ant-radio-group,.el-radio-group,[class*="bs-radio-group"]',
    checkboxGroup: '.ant-checkbox-group,.el-checkbox-group,[class*="bs-checkbox-group"]',
    addButton: '[class*="add"],button,[role="button"]',
    range: '.ant-picker-range,.el-range-editor,.el-date-editor--daterange,.el-date-editor--monthrange'
  },
  controls: [],
  settleDelayMs: 260
}

