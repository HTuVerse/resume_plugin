import type { PlatformAdapter } from './contracts'

export const feishuAdapter: PlatformAdapter = {
  id: 'feishu-jobs',
  family: 'feishu',
  name: '飞书招聘',
  version: '2026.10',
  priority: 90,
  hostPatterns: [/(?:^|\.)jobs\.feishu\.cn$/i],
  indicatorOnlyThreshold: 2,
  indicators: ['.ud-formily-item', '[data-form-field-id]', '[data-form-field-name]', '[class*="applyFormModuleWrapper"]'],
  selectors: {
    formItem: '.ud-formily-item,[data-form-field-id],[data-form-field-name],[class*="form-item"]',
    label: '.ud-formily-item-label-content,label,[data-form-field-i18n-name],[class*="field-label"]',
    section: '[class*="applyFormModuleWrapper-text"],[class*="module-title"],[class*="section-title"]',
    repeatItem: '[data-form-array-item],[class*="form-array-item"],[class*="record-item"],[class*="card-item"]',
    select: '.ud-select,.ud-select-view,.ud-input-tag',
    cascade: '.ud-cascader,[class*="ud-cascader"]',
    date: '.ud-date-picker,.ud-picker,[class*="ud-date"]',
    popup: '.ud-select-dropdown,.ud-dropdown-menu,.ud-picker-popup,.ud-cascader-popup',
    option: '.ud-select-option,.ud-dropdown-item,[data-option-id]',
    selectionItem: '.ud-select-view-value,.ud-tag,.ud-input-tag-tag',
    searchInput: '.ud-select input,.ud-input-tag input,[aria-autocomplete="list"]',
    choiceWrapper: '.ud-radio,.ud-checkbox',
    radioGroup: '.ud-radio-group',
    checkboxGroup: '.ud-checkbox-group',
    addButton: '.ud-button,[class*="add"],button,[role="button"]',
    range: '.ud-date-range,[class*="ud-range-picker"]'
  },
  controls: [
    { selector: '.ud-select,.ud-select-view,.ud-input-tag', type: 'select', confidence: 0.97, evidence: 'feishu:ud-select', capabilities: { canClick: true, canSearch: true, canScroll: true } },
    { selector: '.ud-cascader,[class*="ud-cascader"]', type: 'cascade', confidence: 0.97, evidence: 'feishu:ud-cascade', capabilities: { canClick: true, canSearch: true, canScroll: true } },
    { selector: '.ud-date-picker,.ud-picker,[class*="ud-date"]', type: 'date', confidence: 0.97, evidence: 'feishu:ud-date', capabilities: { canClick: true, canUseKeyboard: true } }
  ],
  settleDelayMs: 280
}

