import type { FillRequest, FillResult, FormField } from '../../domain/types'
import { choiceGroupOf, readClickedChoice, readCurrentValue, scanPage, type FieldRef } from '../../features/autofill/scan/collector'
import { visibleChoiceText } from '../../features/autofill/scan/labelResolver'
import { isElementVisible } from '../../features/autofill/write/domUtils'
import { isPlaceholderOption } from '../../features/ontology/optionMatch'
import { scoreFieldSlots, decideSlot } from '../../features/autofill/match/fieldToSlot'
import { executeFill, undoRecord, type UndoRecord } from '../../features/autofill/write/writeMachine'
import { loadLearnedAliases } from '../../features/ontology/learnedAliases'
import { loadSiteRules, rulesForDomain } from '../../features/siteRules/ruleStore'
import { LICENSE_REQUIRED_MESSAGE, loadLicense } from '../../features/license/license'

/**
 * 内容脚本编排层（TECH_DESIGN §10）。
 *
 * 角色判定：window.top === window 为 COORDINATOR（宿主面板、聚合各 frame）；
 * 否则为 WORKER（只做扫描与写入，不挂面板）。
 * frame 间通信走 background 中继，不走 window.postMessage。
 */

declare global { interface Window { __resumeFormAssistantRuntime?: string } }

const CONTENT_RUNTIME = 'hongtu-resume-autofill-2.0.0'
const TOGGLE_EVENT = `resume-autofill-toggle-${CONTENT_RUNTIME}`
const IS_COORDINATOR = window.top === window

if (window.__resumeFormAssistantRuntime !== CONTENT_RUNTIME) {
  window.__resumeFormAssistantRuntime = CONTENT_RUNTIME

  // ─── 各 frame 共用：扫描 / 填写 / 撤销 ─────────────────────

  let refs = new Map<string, FieldRef>()
  let undoStack: UndoRecord[] = []
  let lastFingerprints = new Set<string>()
  let hasScanned = false
  /** 插件自己写入期间不把回读当成用户输入。 */
  let learnPaused = false
  const learnState = new Map<string, { timer: number; started: number; ref: FieldRef; picked: string }>()
  /** 点过的单选。页面只改样式、回读仍是旧值时，用这次点中的文字。 */
  const choiceOverride = new Map<string, { text: string; previous: string }>()
  let learnObservers: MutationObserver[] = []
  let fieldWatchInstalled = false
  /** 最近一次点中的下拉、日期或单选。选项弹层挂在 body 上，点击时要靠它认回字段。 */
  let activeLearn: { fingerprint: string; ref: FieldRef } | null = null

  const CHOICE_KINDS = new Set(['radio', 'checkbox', 'select', 'multiselect', 'combobox', 'cascade', 'date'])
  const POPUP_SELECTOR = '.ant-select-dropdown,.el-select-dropdown,.el-select__popper,.el-picker__popper,.arco-select-dropdown,.arco-trigger-popup,.n-base-select-menu,.ivu-select-dropdown,.semi-select-dropdown,.t-select__dropdown,.t-popup,.ant-picker-dropdown,.ant-picker-panel,.el-picker-panel,.el-time-panel,.arco-picker-panel,[role="listbox"]'
  const WATCH_WIDGET = '.ant-select,.el-select,.arco-select,.n-select,.ivu-select,.ant-radio-group,.el-radio-group,.arco-radio-group,.n-radio-group,.ivu-radio-group,.van-radio-group,.t-radio-group,.semi-radio-group,[role="radiogroup"],.ant-picker,.el-date-editor,.arco-picker,.el-time-select,[class*="date-picker"],[class*="time-picker"]'
  const OPEN_CHOICE = '.ant-select-open,.ant-select-focused,.el-select.is-focused,.ant-picker-focused,.el-date-editor.is-active,.arco-select-open,.arco-picker-focused'
  const OPTION_NODE = '[role="option"],.ant-select-item-option,.ant-select-item,.el-select-dropdown__item,.arco-select-option,.n-base-select-option,.semi-select-option,.t-select-option,.ivu-select-item,.ant-cascader-menu-item,.el-cascader-node,[class*="select-option"],[class*="dropdown-item"]'
  const CHOICE_BOX = 'label,.el-radio,.el-radio-button,.el-checkbox,.ant-radio-wrapper,.ant-radio-button-wrapper,.arco-radio,.n-radio,.ivu-radio-wrapper,.van-radio,.t-radio,.semi-radio,[role="radio"],[role="checkbox"]'

  function choicePopupOpen(ref: FieldRef): boolean {
    const host = ref.element.closest(WATCH_WIDGET) || ref.element
    if (host.matches(OPEN_CHOICE) || Boolean(host.querySelector(OPEN_CHOICE))) return true
    if (activeLearn?.ref.element !== ref.element) return false
    const popup = document.querySelector<HTMLElement>(POPUP_SELECTOR)
    return Boolean(popup && isElementVisible(popup))
  }

  /** 点在下拉选项上时，立刻记下可见文字。弹层经常在 click 之前就拆掉，不能等回读。 */
  function pickedOptionText(target: HTMLElement): string {
    const popup = target.closest(POPUP_SELECTOR)
    if (!popup) return ''
    if (target.closest('.ant-picker-panel,.el-picker-panel,.el-time-panel,.arco-picker-panel,.ant-picker-cell,.el-date-table')) {
      const title = target.closest<HTMLElement>('[title]')?.getAttribute('title')?.trim() || ''
      return /^\d{4}[-/.年]\d{1,2}/.test(title) ? title : ''
    }
    const option = target.closest<HTMLElement>(OPTION_NODE)
    if (!option || !popup.contains(option)) return ''
    const text = visibleChoiceText(option)
    return text && !isPlaceholderOption(text) ? text : ''
  }

  function pickedRadioText(target: HTMLElement, ref: FieldRef): string {
    const text = readClickedChoice(target, ref)
    return text && !isPlaceholderOption(text) ? text : ''
  }

  function rememberChoice(fingerprint: string, ref: FieldRef, text: string): void {
    const picked = text.trim()
    if (!picked || (ref.kind !== 'radio' && ref.kind !== 'checkbox')) return
    const live = ref.element.isConnected ? readCurrentValue(ref).trim() : ''
    if (picked === live) {
      choiceOverride.delete(fingerprint)
      return
    }
    choiceOverride.set(fingerprint, { text: picked, previous: live })
  }

  /** 单选回读还停在点之前的值时，用点中的选项。样式跟上之后再改回读页面。 */
  function observedChoice(fingerprint: string, ref: FieldRef, fallback = ''): string {
    const live = ref.element.isConnected ? readCurrentValue(ref).trim() : ''
    const override = choiceOverride.get(fingerprint)
    if (override) {
      if (live === override.text || (live && live !== override.previous)) {
        choiceOverride.delete(fingerprint)
        return live
      }
      return override.text
    }
    return fallback.trim() || live
  }

  function emitLearned(fingerprint: string, ref: FieldRef, fallback = ''): void {
    let current = ref
    if (!ref.element.isConnected) {
      const output = scanPage()
      refs = output.refs
      const rebound = refs.get(fingerprint)
      if (!rebound) return
      current = rebound
    }
    if (learnPaused) {
      scheduleLearn(fingerprint, current, 0, fallback)
      return
    }
    const value = observedChoice(fingerprint, current, fallback)
    chrome.runtime.sendMessage({ type: 'FIELD_OBSERVED', fieldId: fingerprint, value }).catch(() => undefined)
  }

  /**
   * 页面变更后读最终值。点过的选项文字优先保留，弹层还开着且两边都空时再等一会儿。
   */
  function scheduleLearn(fingerprint: string, ref: FieldRef, attempt = 0, picked = ''): void {
    const state = learnState.get(fingerprint)
    const choiceText = (picked || state?.picked || '').trim()
    if (state) window.clearTimeout(state.timer)
    const wait = attempt === 0 ? 280 : 320
    const timer = window.setTimeout(() => {
      const latest = learnState.get(fingerprint)
      const currentRef = latest?.ref || ref
      const remembered = (latest?.picked || choiceText).trim()
      const value = observedChoice(fingerprint, currentRef, remembered)
      if (!value && !remembered && choicePopupOpen(currentRef) && attempt < 12) {
        scheduleLearn(fingerprint, currentRef, attempt + 1, remembered)
        return
      }
      learnState.delete(fingerprint)
      emitLearned(fingerprint, currentRef, remembered)
    }, wait)
    learnState.set(fingerprint, { timer, started: state?.started ?? Date.now(), ref, picked: choiceText })
  }

  function matchRef(target: HTMLElement, source: Map<string, FieldRef>): { fingerprint: string; ref: FieldRef } | undefined {
    const box = target.closest(CHOICE_BOX)
    const boxHasMany = Boolean(box && box.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]').length > 1)
    const sameChoice = (choice: HTMLElement) => choice === target
      || choice.contains(target)
      || target.contains(choice)
      || Boolean(box && !boxHasMany && (box === choice || box.contains(choice) || choice.contains(box)))
      || choice === target.previousElementSibling
      || choice === target.nextElementSibling
    for (const [fingerprint, ref] of source) {
      if (ref.element === target || ref.element.contains(target)) return { fingerprint, ref }
      if (ref.radios?.some(sameChoice)) return { fingerprint, ref }
      if (ref.checkboxes?.some(sameChoice)) return { fingerprint, ref }
      if (ref.choices?.some(sameChoice)) return { fingerprint, ref }
      const group = ref.kind === 'radio' || ref.kind === 'checkbox' ? choiceGroupOf(ref) : null
      if (group && (group === target || group.contains(target)) && readClickedChoice(target, ref)) return { fingerprint, ref }
    }
    const widget = target.closest(WATCH_WIDGET)
    if (!widget) return undefined
    let hostMatch: { fingerprint: string; ref: FieldRef } | undefined
    for (const [fingerprint, ref] of source) {
      if (widget !== ref.element && !widget.contains(ref.element) && !ref.element.contains(widget)) continue
      if (ref.element === target || ref.element.contains(target) || target.contains(ref.element)) return { fingerprint, ref }
      hostMatch = { fingerprint, ref }
    }
    return hostMatch
  }

  function refForTarget(target: EventTarget | null): { fingerprint: string; ref: FieldRef } | undefined {
    if (!(target instanceof HTMLElement)) return undefined
    const found = matchRef(target, refs)
    if (found) return found
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return undefined
    const output = scanPage()
    refs = output.refs
    return matchRef(target, refs)
  }

  /** 弹层挂在 body 上时，用当前展开的下拉或日期控件认回字段。 */
  function openedChoice(): { fingerprint: string; ref: FieldRef } | undefined {
    const host = document.querySelector<HTMLElement>(OPEN_CHOICE)
    if (!host || host.closest(POPUP_SELECTOR)) return undefined
    return matchRef(host, refs)
  }

  function flushPendingLearn(): void {
    if (learnPaused) return
    for (const [fingerprint, state] of [...learnState]) {
      const value = state.ref.element.isConnected ? readCurrentValue(state.ref).trim() : ''
      if (!value && choicePopupOpen(state.ref)) continue
      window.clearTimeout(state.timer)
      learnState.delete(fingerprint)
      emitLearned(fingerprint, state.ref, state.picked)
    }
  }

  function installFieldWatch(): void {
    if (fieldWatchInstalled) return
    fieldWatchInstalled = true
    const rememberActive = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.closest('[data-resume-assistant]')) return
      const picked = pickedOptionText(target)
      if (picked) {
        const owner = openedChoice() || activeLearn
        if (owner && CHOICE_KINDS.has(owner.ref.kind)) {
          activeLearn = owner
          scheduleLearn(owner.fingerprint, owner.ref, 0, picked)
          return
        }
      }
      const found = refForTarget(target)
      if (!found) return
      activeLearn = found
      const radioText = pickedRadioText(target, found.ref)
      if (radioText) {
        rememberChoice(found.fingerprint, found.ref, radioText)
        scheduleLearn(found.fingerprint, found.ref, 0, radioText)
      }
    }
    const onEdit = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.closest('[data-resume-assistant]')) return
      const picked = pickedOptionText(target)
      const popup = target.closest(POPUP_SELECTOR)
      if (popup || picked) {
        const owner = openedChoice() || activeLearn
        if (owner && CHOICE_KINDS.has(owner.ref.kind)) {
          activeLearn = owner
          scheduleLearn(owner.fingerprint, owner.ref, 0, picked)
          return
        }
      }
      const found = refForTarget(target)
      if (!found) return
      activeLearn = found
      const radioText = pickedRadioText(target, found.ref)
      if (radioText) rememberChoice(found.fingerprint, found.ref, radioText)
      scheduleLearn(found.fingerprint, found.ref, 0, radioText)
    }
    document.addEventListener('pointerdown', rememberActive, true)
    document.addEventListener('input', onEdit, true)
    document.addEventListener('compositionend', onEdit, true)
    document.addEventListener('change', onEdit, true)
    document.addEventListener('focusout', onEdit, true)
    document.addEventListener('click', onEdit, true)
    // 切到其它应用时，等待中的定时器会被系统推迟，离开前先把已观察到的值发出去。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingLearn()
    })
  }
  let featureSettings: Record<string, unknown> & { autoHighlight?: boolean; debugMode?: boolean } = { autoHighlight: true, debugMode: false }

  chrome.storage.local.get('featureSettingsV1').then(stored => {
    if (stored.featureSettingsV1) featureSettings = { ...featureSettings, ...stored.featureSettingsV1 }
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.featureSettingsV1?.newValue) {
      featureSettings = { ...featureSettings, ...changes.featureSettingsV1.newValue }
    }
  })

  async function frameScan(): Promise<{ fields: FormField[]; url: string; title: string }> {
    const [rules, learnedAliases] = await Promise.all([
      loadSiteRules().then(rows => rulesForDomain(rows, location.hostname)).catch(() => []),
      loadLearnedAliases().catch(() => [])
    ])
    const output = scanPage()
    refs = output.refs
    hasScanned = true
    lastFingerprints = new Set(output.fields.map(field => field.fingerprint))
    for (const field of output.fields) {
      const scores = scoreFieldSlots(field, { siteRules: rules, learnedAliases })
      const decision = decideSlot(scores, field.sectionId)
      field.slotCandidates = decision.candidates
      field.slotStatus = decision.status
      field.slot = decision.slot
      if (decision.candidates[0]?.locked) {
        field.ruleId = rules.find(rule => rule.fieldFingerprint === field.fingerprint && !rule.disabled)?.id
      }
    }
    if (featureSettings.debugMode) console.debug('[鸿途网申助手] scan', { frame: IS_COORDINATOR ? 'top' : 'worker', fields: output.fields })
    watchLearnedInputs()
    return { fields: output.fields, url: location.href, title: document.title }
  }

  /** 按指纹定位控件；引用失效时重扫后按同一指纹重取（禁止位置猜测，R8 修复）。 */
  function locateRef(fingerprint: string): FieldRef | undefined {
    const existing = refs.get(fingerprint)
    if (existing?.element.isConnected) return existing
    const output = scanPage()
    refs = output.refs
    watchLearnedInputs()
    return refs.get(fingerprint)
  }

  function elementsOf(ref: FieldRef): HTMLElement[] {
    if (ref.kind === 'radio') return [...(ref.radios || []), ...(ref.choices || [])]
    if (ref.kind === 'checkbox') return ref.checkboxes || [ref.element as HTMLInputElement]
    return [ref.element]
  }

  /** 识别之后持续观察用户在网页上的输入，交给面板整理成知识库候选。 */
  function watchLearnedInputs(): void {
    installFieldWatch()
    for (const observer of learnObservers) observer.disconnect()
    learnObservers = []
    for (const [fingerprint, ref] of refs) {
      if (!CHOICE_KINDS.has(ref.kind)) continue
      const widget = (ref.element.closest(WATCH_WIDGET) || choiceGroupOf(ref)) as HTMLElement | null
      const observer = new MutationObserver(() => scheduleLearn(fingerprint, ref))
      observer.observe(widget || ref.element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'title', 'value', 'checked', 'aria-checked', 'aria-selected'] })
      learnObservers.push(observer)
    }
  }

  async function frameFill(values: FillRequest[], resetUndo: boolean): Promise<FillResult[]> {
    learnPaused = true
    try {
      if (resetUndo) undoStack = []
      const results: FillResult[] = []
      for (const request of values) {
        const execution = await executeFill(request, () => locateRef(request.fieldId))
        if (execution.result.status === 'filled' && execution.undo) {
          undoStack.push(execution.undo)
          highlight(execution.undo.ref, execution.result)
        }
        results.push(execution.result)
      }
      return results
    } finally {
      window.setTimeout(() => { learnPaused = false }, 700)
    }
  }

  /** 回读本 frame 已识别字段的当前值（面板「学习手动输入」用，不做任何写入）。 */
  function frameValues(): { values: Array<{ fieldId: string; value: string }> } {
    const stale = [...refs.values()].some(ref => !ref.element.isConnected
      || ref.radios?.some(radio => !radio.isConnected)
      || ref.choices?.some(choice => !choice.isConnected))
    if (stale) {
      const output = scanPage()
      refs = output.refs
      watchLearnedInputs()
    }
    const values: Array<{ fieldId: string; value: string }> = []
    for (const [fingerprint, ref] of refs) {
      if (!ref.element.isConnected) continue
      values.push({ fieldId: fingerprint, value: observedChoice(fingerprint, ref) })
    }
    return { values }
  }

  async function frameUndo(): Promise<FillResult[]> {
    const results: FillResult[] = []
    for (const record of [...undoStack].reverse()) {
      const problem = await undoRecord(record)
      clearHighlight(record)
      results.push(problem
        ? { fieldId: record.fieldId, status: 'failed', message: problem }
        : { fieldId: record.fieldId, status: 'filled', message: '已恢复原值' })
    }
    undoStack = []
    return results
  }

  function highlight(ref: FieldRef, result: FillResult): void {
    if (!featureSettings.autoHighlight) return
    const pending = result.source === 'ai'
    for (const element of elementsOf(ref)) {
      element.setAttribute('data-resume-assistant-filled', 'true')
      element.setAttribute('data-resume-assistant-state', pending ? 'pending' : 'confirmed')
      element.setAttribute('title', pending
        ? `鸿途网申助手：AI 判定语义（置信度 ${Math.round((result.confidence || 0) * 100)}%），请确认`
        : `鸿途网申助手：已填写并回读确认`)
      element.style.outline = pending ? '2px solid #e28a13' : '2px solid #20744c'
      element.style.outlineOffset = '1px'
    }
  }

  function clearHighlight(record: UndoRecord): void {
    for (const element of elementsOf(record.ref)) {
      element.removeAttribute('data-resume-assistant-filled')
      element.removeAttribute('data-resume-assistant-state')
      element.style.outline = record.outline
      element.style.outlineOffset = record.outlineOffset
      if (record.title) element.setAttribute('title', record.title)
      else element.removeAttribute('title')
    }
  }

  function confirmField(fingerprint: string): { status: 'confirmed' | 'missing' } {
    const ref = refs.get(fingerprint)
    if (!ref?.element.isConnected) return { status: 'missing' }
    for (const element of elementsOf(ref)) {
      element.setAttribute('data-resume-assistant-state', 'confirmed')
      element.style.outline = '2px solid #20744c'
    }
    return { status: 'confirmed' }
  }

  // ─── 页面变化感知（F16）：只提示不动作 ─────────────────────

  let mutationTimer = 0
  const observer = new MutationObserver(() => {
    if (!hasScanned) return
    window.clearTimeout(mutationTimer)
    mutationTimer = window.setTimeout(() => {
      // 轻量指纹 diff：只跑收集与指纹，不跑打分
      const output = scanPage()
      const added = output.fields.filter(field => !lastFingerprints.has(field.fingerprint)).length
      if (added > 0) {
        chrome.runtime.sendMessage({ type: 'PAGE_MUTATED', added }).catch(() => undefined)
      }
    }, 800)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  // ─── background 中继消息（各 frame 都要响应）───────────────

  function denyUnlessLicensed(respond: (response: unknown) => void, run: () => void): void {
    loadLicense()
      .then(record => {
        if (!record) respond({ error: LICENSE_REQUIRED_MESSAGE })
        else run()
      })
      .catch(error => respond({ error: String(error) }))
  }

  chrome.runtime.onMessage.addListener((message: { type: string; values?: FillRequest[]; fieldId?: string; value?: string; sourceFrameId?: number; resetUndo?: boolean; added?: number }, _sender, respond) => {
    if (message.type === 'FRAME_SCAN') {
      denyUnlessLicensed(respond, () => {
        frameScan().then(respond).catch(error => respond({ error: String(error) }))
      })
      return true
    }
    if (message.type === 'FRAME_FILL') {
      denyUnlessLicensed(respond, () => {
        frameFill(message.values || [], message.resetUndo !== false).then(results => respond({ results })).catch(error => respond({ error: String(error) }))
      })
      return true
    }
    if (message.type === 'FRAME_UNDO') {
      denyUnlessLicensed(respond, () => {
        frameUndo().then(results => respond({ results })).catch(error => respond({ error: String(error) }))
      })
      return true
    }
    if (message.type === 'FRAME_VALUES') {
      denyUnlessLicensed(respond, () => respond(frameValues()))
      return true
    }
    if (message.type === 'FRAME_CONFIRM') {
      denyUnlessLicensed(respond, () => respond(confirmField(message.fieldId || '')))
      return true
    }
    if (message.type === 'FRAME_MUTATED' && IS_COORDINATOR) {
      postPanelEvent({ type: 'PAGE_MUTATED', added: message.added || 0 })
      respond({})
      return false
    }
    if (message.type === 'FRAME_OBSERVED' && IS_COORDINATOR) {
      const sourceFrameId = message.sourceFrameId ?? 0
      postPanelEvent({ type: 'FIELD_OBSERVED', fieldId: fieldIdOf(sourceFrameId, message.fieldId || ''), value: message.value || '' })
      respond({})
      return false
    }
    return false
  })

  // 注册本 frame（background 维护 tab → frameId 集合）
  chrome.runtime.sendMessage({ type: 'FRAME_HELLO' }).catch(() => undefined)

  // ─── COORDINATOR：面板宿主 / 聚合 / 拾取器 / 拖拽 ──────────

  let panelHost: HTMLElement | null = null
  let panelFrame: HTMLIFrameElement | null = null
  let stopPanelDrag: (() => void) | null = null
  let panelPosition: { left: number; top: number } | null = null
  let pickerCleanup: (() => void) | null = null
  let lastFocusedFieldId: string | null = null
  const panelOrigin = new URL(chrome.runtime.getURL('/')).origin

  function fieldIdOf(frameId: number, fingerprint: string): string {
    return `${frameId}:${fingerprint}`
  }

  function splitFieldId(fieldId: string): { frameId: number; fingerprint: string } {
    const separator = fieldId.indexOf(':')
    if (separator < 0) return { frameId: 0, fingerprint: fieldId }
    return { frameId: Number(fieldId.slice(0, separator)) || 0, fingerprint: fieldId.slice(separator + 1) }
  }

  async function frameCall<T>(frameId: number, message: object): Promise<T> {
    return chrome.runtime.sendMessage({ type: 'FRAME_CALL', frameId, message }) as Promise<T>
  }

  async function listFrames(): Promise<number[]> {
    const response = await chrome.runtime.sendMessage({ type: 'LIST_FRAMES' }).catch(() => null) as { frameIds?: number[] } | null
    return response?.frameIds?.length ? response.frameIds : [0]
  }

  async function aggregateScan(): Promise<{ fields: FormField[]; context: { pageTitle: string; url: string; frames: Array<{ frameId: number; url: string; fieldCount: number }> } }> {
    const frameIds = await listFrames()
    const fields: FormField[] = []
    const frames: Array<{ frameId: number; url: string; fieldCount: number }> = []
    let pageTitle = document.title
    for (const frameId of frameIds) {
      const response = await frameCall<{ fields?: FormField[]; url?: string; title?: string; error?: string } | null>(frameId, { type: 'FRAME_SCAN' }).catch(() => null)
      if (!response?.fields) continue
      for (const field of response.fields) {
        field.frameId = frameId
        field.id = fieldIdOf(frameId, field.fingerprint)
        fields.push(field)
      }
      frames.push({ frameId, url: response.url || '', fieldCount: response.fields.length })
      if (frameId === 0 && response.title) pageTitle = response.title
    }
    return { fields, context: { pageTitle, url: location.href, frames } }
  }

  async function aggregateFill(values: FillRequest[]): Promise<FillResult[]> {
    const groups = new Map<number, FillRequest[]>()
    for (const request of values) {
      const { frameId, fingerprint } = splitFieldId(request.fieldId)
      const list = groups.get(frameId) || []
      list.push({ ...request, fieldId: fingerprint })
      groups.set(frameId, list)
    }
    const results: FillResult[] = []
    for (const [frameId, group] of groups) {
      const response = await frameCall<{ results?: FillResult[]; error?: string } | null>(frameId, { type: 'FRAME_FILL', values: group, resetUndo: true }).catch(() => null)
      for (const result of response?.results || group.map(request => ({ fieldId: request.fieldId, status: 'failed' as const, message: '目标 frame 无响应', reasonCode: 'element-lost' as const }))) {
        results.push({ ...result, fieldId: fieldIdOf(frameId, result.fieldId) })
      }
    }
    return results
  }

  async function aggregateValues(): Promise<{ values: Array<{ fieldId: string; value: string }> }> {
    const frameIds = await listFrames()
    const values: Array<{ fieldId: string; value: string }> = []
    for (const frameId of frameIds) {
      const response = await frameCall<{ values?: Array<{ fieldId: string; value: string }> } | null>(frameId, { type: 'FRAME_VALUES' }).catch(() => null)
      for (const row of response?.values || []) {
        values.push({ fieldId: fieldIdOf(frameId, row.fieldId), value: row.value })
      }
    }
    return { values }
  }

  async function aggregateUndo(): Promise<FillResult[]> {
    const frameIds = await listFrames()
    const results: FillResult[] = []
    for (const frameId of frameIds) {
      const response = await frameCall<{ results?: FillResult[] } | null>(frameId, { type: 'FRAME_UNDO' }).catch(() => null)
      results.push(...(response?.results || []))
    }
    return results
  }

  function postPanelEvent(event: unknown): void {
    panelFrame?.contentWindow?.postMessage({ type: 'PANEL_EVENT', event }, panelOrigin)
  }

  // ─── 手动辅助填写 / 拾取器（顶层 frame 内）──────────────────

  function fieldEntryForTarget(target: EventTarget | null): [string, FieldRef] | undefined {
    if (!(target instanceof HTMLElement)) return undefined
    const control = target instanceof HTMLLabelElement && target.control
      ? target.control
      : target.closest<HTMLElement>('input,textarea,select,[role="combobox"],[contenteditable="true"]') || target
    for (const entry of refs.entries()) {
      const [, ref] = entry
      if (ref.element === control || ref.element === target || ref.element.contains(control) || ref.element.contains(target)) return entry
      if (control instanceof HTMLInputElement && (ref.radios?.includes(control) || ref.checkboxes?.includes(control))) return entry
    }
    return undefined
  }

  document.addEventListener('focusin', event => {
    if (!(event.target instanceof HTMLElement) || event.target.closest('[data-resume-assistant]')) return
    const entry = fieldEntryForTarget(event.target)
    if (entry) lastFocusedFieldId = entry[0]
  }, true)

  async function manualFill(message: { fieldId: string; value: string; source?: FillRequest['source']; confidence?: number; copied?: boolean }): Promise<unknown> {
    const { frameId, fingerprint } = splitFieldId(message.fieldId)
    // 面板字段列表发起的填写：目标明确，直接走对应 frame
    if (refs.has(fingerprint) || frameId !== 0) {
      const response = await frameCall<{ results?: FillResult[] } | null>(frameId, {
        type: 'FRAME_FILL',
        values: [{ fieldId: fingerprint, value: message.value, overwrite: true, source: message.source, confidence: message.confidence }],
        resetUndo: false
      }).catch(() => null)
      const result = response?.results?.[0]
      if (result) return { status: 'filled', copied: message.copied !== false, result: { ...result, fieldId: message.fieldId } }
    }
    // 中心字段快速填写：优先最近聚焦的输入框，否则进入拾取模式
    if (lastFocusedFieldId && refs.get(lastFocusedFieldId)?.element.isConnected) {
      const results = await frameFill([{ fieldId: lastFocusedFieldId, value: message.value, overwrite: true, source: message.source, confidence: message.confidence }], false)
      return { status: 'filled', copied: message.copied !== false, result: results[0] }
    }
    startPicker(message)
    return { status: 'picker', copied: message.copied !== false, message: '请点击网页中的目标输入框。' }
  }

  function startPicker(message: { fieldId: string; value: string; source?: FillRequest['source']; confidence?: number; copied?: boolean }): void {
    pickerCleanup?.()
    let highlighted: { elements: HTMLElement[]; styles: Array<{ outline: string; outlineOffset: string }> } | null = null
    const restoreHighlight = () => {
      highlighted?.elements.forEach((element, index) => {
        const style = highlighted?.styles[index]
        if (style) {
          element.style.outline = style.outline
          element.style.outlineOffset = style.outlineOffset
        }
      })
      highlighted = null
    }
    const highlightTarget = (ref?: FieldRef) => {
      restoreHighlight()
      if (!ref) return
      const elements = elementsOf(ref)
      highlighted = { elements, styles: elements.map(element => ({ outline: element.style.outline, outlineOffset: element.style.outlineOffset })) }
      elements.forEach(element => {
        element.style.outline = '2px solid #b05d16'
        element.style.outlineOffset = '1px'
      })
    }
    const onMove = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.closest('[data-resume-assistant]')) return
      highlightTarget(fieldEntryForTarget(target)?.[1])
    }
    const onClick = async (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.closest('[data-resume-assistant]')) return
      const entry = fieldEntryForTarget(target)
      if (!entry) return
      event.preventDefault()
      event.stopPropagation()
      const results = await frameFill([{ fieldId: entry[0], value: message.value, overwrite: true, source: message.source, confidence: message.confidence }], false)
      postPanelEvent({ type: 'PICKER_RESULT', copied: message.copied !== false, result: results[0] })
      pickerCleanup?.()
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    pickerCleanup = () => {
      restoreHighlight()
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      pickerCleanup = null
    }
  }

  // ─── 面板宿主与拖拽（沿用 1.1 实现）─────────────────────────

  const PANEL_SIZES = {
    compact: { width: 288, height: 392, gutterX: 20, gutterY: 24 },
    expanded: { width: 432, height: 515, gutterX: 24, gutterY: 24 },
    activation: { width: 580, height: 430, gutterX: 24, gutterY: 24 }
  } as const

  type PanelMode = keyof typeof PANEL_SIZES

  function availablePanelSize(mode: PanelMode): { width: number; height: number } {
    const size = PANEL_SIZES[mode]
    return {
      width: Math.max(0, Math.min(size.width, window.innerWidth - size.gutterX)),
      height: Math.max(0, Math.min(size.height, window.innerHeight - size.gutterY))
    }
  }

  function applyPanelSize(mode: PanelMode): void {
    if (!panelHost) return
    const size = PANEL_SIZES[mode]
    panelHost.style.width = `min(${size.width}px, calc(100vw - ${size.gutterX}px))`
    panelHost.style.height = `min(${size.height}px, calc(100vh - ${size.gutterY}px))`
  }

  function closePanelView(): void {
    stopPanelDrag?.()
    panelHost?.remove()
    panelHost = null
    panelFrame = null
  }

  function mountPanel(): void {
    if (panelHost) {
      panelHost.hidden = !panelHost.hidden
      if (!panelHost.hidden) requestAnimationFrame(ensurePanelInViewport)
      return
    }
    panelHost = document.createElement('div')
    panelHost.id = 'resume-form-assistant-panel'
    panelHost.setAttribute('data-resume-assistant', 'panel')
    panelHost.style.cssText = 'position:fixed;right:12px;top:12px;width:min(288px,calc(100vw - 20px));height:min(392px,calc(100vh - 24px));z-index:2147483647;pointer-events:auto;transition:width .22s ease,height .22s ease,top .22s ease,right .22s ease;'
    const shadow = panelHost.attachShadow({ mode: 'closed' })
    panelFrame = document.createElement('iframe')
    panelFrame.title = '鸿途网申助手'
    panelFrame.src = chrome.runtime.getURL('panel.html')
    panelFrame.style.cssText = 'width:100%;height:100%;border:0;border-radius:14px;background:transparent;box-shadow:0 14px 42px rgba(12,35,24,.22);'
    shadow.append(panelFrame)
    document.documentElement.append(panelHost)
    if (panelPosition) ensurePanelInViewport()
  }

  function ensurePanelInViewport(): void {
    if (!panelHost || panelHost.hidden || !panelPosition) return
    const rect = panelHost.getBoundingClientRect()
    const left = Math.max(0, Math.min(panelPosition.left, window.innerWidth - rect.width))
    const top = Math.max(0, Math.min(panelPosition.top, window.innerHeight - rect.height))
    panelPosition = { left, top }
    panelHost.style.left = `${left}px`
    panelHost.style.top = `${top}px`
    panelHost.style.right = 'auto'
  }

  function resizePanelHost(mode: PanelMode): void {
    if (!panelHost) return
    const moved = panelHost.style.left !== '' && panelHost.style.left !== 'auto'
    const previous = panelHost.getBoundingClientRect()
    applyPanelSize(mode)
    if (!moved) {
      panelHost.style.top = '12px'
      panelHost.style.right = '12px'
    } else {
      const { width: nextWidth, height: nextHeight } = availablePanelSize(mode)
      panelHost.style.left = `${Math.max(0, Math.min(previous.left, window.innerWidth - nextWidth))}px`
      panelHost.style.top = `${Math.max(0, Math.min(previous.top, window.innerHeight - nextHeight))}px`
      panelHost.style.right = 'auto'
      panelPosition = { left: Number.parseFloat(panelHost.style.left), top: Number.parseFloat(panelHost.style.top) }
    }
  }

  function startPanelDrag(offsetX: number, offsetY: number): void {
    if (!panelHost || !panelFrame) return
    stopPanelDrag?.()
    const host = panelHost
    const frame = panelFrame
    const startRect = host.getBoundingClientRect()
    const maxLeft = Math.max(0, window.innerWidth - startRect.width)
    const maxTop = Math.max(0, window.innerHeight - startRect.height)
    let nextLeft = startRect.left
    let nextTop = startRect.top
    let animationFrame = 0
    const render = () => {
      animationFrame = 0
      host.style.transform = `translate3d(${nextLeft - startRect.left}px, ${nextTop - startRect.top}px, 0)`
    }
    const onMove = (event: PointerEvent) => {
      nextLeft = Math.min(maxLeft, Math.max(0, event.clientX - offsetX))
      nextTop = Math.min(maxTop, Math.max(0, event.clientY - offsetY))
      if (!animationFrame) animationFrame = requestAnimationFrame(render)
    }
    const finish = () => stopPanelDrag?.()
    stopPanelDrag = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', finish, true)
      document.removeEventListener('pointercancel', finish, true)
      const transition = host.style.transition
      host.style.transition = 'none'
      host.style.transform = 'none'
      host.style.left = `${nextLeft}px`
      host.style.top = `${nextTop}px`
      host.style.right = 'auto'
      panelPosition = { left: nextLeft, top: nextTop }
      requestAnimationFrame(() => { if (host.isConnected) host.style.transition = transition })
      frame.style.pointerEvents = 'auto'
      stopPanelDrag = null
    }
    frame.style.pointerEvents = 'none'
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', finish, true)
    document.addEventListener('pointercancel', finish, true)
  }

  // ─── 面板消息路由（仅 COORDINATOR）──────────────────────────

  async function handlePanelMessage(message: { type: string; values?: FillRequest[]; fieldId?: string; value?: string; source?: FillRequest['source']; confidence?: number; copied?: boolean }): Promise<unknown> {
    if (!(await loadLicense())) return { error: LICENSE_REQUIRED_MESSAGE }
    if (message.type === 'SCAN') return aggregateScan()
    if (message.type === 'FILL') return aggregateFill(message.values || []).then(results => ({ results }))
    if (message.type === 'UNDO') return aggregateUndo().then(results => ({ results }))
    if (message.type === 'READ_VALUES') return aggregateValues()
    if (message.type === 'MANUAL_FILL') return manualFill(message as { fieldId: string; value: string; source?: FillRequest['source']; confidence?: number; copied?: boolean })
    if (message.type === 'CONFIRM_FIELD') {
      const { frameId, fingerprint } = splitFieldId(message.fieldId || '')
      return frameCall(frameId, { type: 'FRAME_CONFIRM', fieldId: fingerprint })
    }
    if (message.type === 'CANCEL_PICKER') {
      pickerCleanup?.()
      return Promise.resolve({ status: 'cancelled' })
    }
    return Promise.resolve({})
  }

  if (IS_COORDINATOR) {
    window.addEventListener('message', event => {
      if (!panelFrame || event.source !== panelFrame.contentWindow || event.origin !== panelOrigin || event.data?.type !== 'PANEL_REQUEST') return
      const { requestId, message } = event.data as { requestId: string; message: { type: string; mode?: 'compact' | 'expanded' | 'activation'; clientX?: number; clientY?: number } }
      if (message.type === 'CLOSE_PANEL' || message.type === 'MINIMIZE_PANEL') { closePanelView(); return }
      if (message.type === 'RESIZE_PANEL') { resizePanelHost(message.mode || 'compact'); return }
      if (message.type === 'DRAG_PANEL') { startPanelDrag(message.clientX || 0, message.clientY || 0); return }
      handlePanelMessage(message as Parameters<typeof handlePanelMessage>[0]).then(response => {
        panelFrame?.contentWindow?.postMessage({ type: 'PANEL_RESPONSE', requestId, response }, panelOrigin)
      }).catch(error => {
        panelFrame?.contentWindow?.postMessage({ type: 'PANEL_RESPONSE', requestId, response: { error: String(error) } }, panelOrigin)
      })
    })

    mountPanel()
    window.addEventListener('resize', ensurePanelInViewport, { passive: true })
    window.addEventListener(TOGGLE_EVENT, () => {
      if (panelHost) closePanelView()
      else mountPanel()
    })
  }
} else if (IS_COORDINATOR) {
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT))
}
