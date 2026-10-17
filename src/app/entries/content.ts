import type { FillRequest, FillResult, FormField } from '../../domain/types'
import { choiceGroupOf, choiceObserveRoots, eventElement, looksLikeChoice, readClickedChoice, readCurrentValue, scanPage, type FieldRef } from '../../features/autofill/scan/collector'
import { visibleChoiceText } from '../../features/autofill/scan/labelResolver'
import { clickAddForSection, clickAddNear } from '../../features/autofill/scan/repeatGroups'
import { isElementVisible, pollUntil, wait } from '../../features/autofill/write/domUtils'
import { normalize } from '../../shared/normalize'
import { isPlaceholderOption } from '../../features/ontology/optionMatch'
import { slotById } from '../../features/ontology/slotRegistry'
import { scoreFieldSlots, decideSlot } from '../../features/autofill/match/fieldToSlot'
import { subjectSectionOf } from '../../features/autofill/match/subjectScope'
import { inferQualifiedField } from '../../features/ontology/recordIdentity'
import { executeFillSequence, undoRecord, type UndoRecord } from '../../features/autofill/write/writeMachine'
import { subscribeTrustedInput } from '../../features/autofill/write/trustedInput'
import { warmupVisualAssist } from '../../features/autofill/write/visualFallback'
import { loadFillRecipes, priorValuesFor, recipeFor, rememberSuccessfulFill } from '../../features/autofill/write/fillRecipes'
import { loadLearnedAliases } from '../../features/ontology/learnedAliases'
import { probeEmptyChoiceOptions } from '../../features/autofill/scan/probeOptions'
import { scanDiagnostics } from '../../features/autofill/diagnostics/trace'
import { findSiteRule, loadSiteRules, rulesForDomain } from '../../features/siteRules/ruleStore'
import { LICENSE_REQUIRED_MESSAGE, loadLicense } from '../../features/license/license'
import { loadInteractionStrategies, preferredStrategyFor, recordInteractionStrategy, successfulStrategy } from '../../features/autofill/learning/strategyMemory'
import { applyLearnedDependencies, captureOptionStates, changedOptionFields, loadFieldDependencies, recordDependencyOutcome, recordFieldDependencies } from '../../features/autofill/learning/dependencyStore'
import { recordQualityResult } from '../../features/autofill/learning/qualityMetrics'
import type { FillOverlayState } from '../bridge/panelBridge'
import {
  PLATFORM_CHOICE_WRAPPER_SELECTOR,
  PLATFORM_DATE_SELECTOR,
  PLATFORM_OPTION_SELECTOR,
  PLATFORM_POPUP_SELECTOR,
  PLATFORM_RADIO_GROUP_SELECTOR,
  PLATFORM_SELECT_SELECTOR
} from '../../features/autofill/platforms/registry'

/**
 * 内容脚本编排层（TECH_DESIGN §10）。
 *
 * 角色判定：window.top === window 为 COORDINATOR（宿主面板、聚合各 frame）；
 * 否则为 WORKER（只做扫描与写入，不挂面板）。
 * frame 间通信走 background 中继，不走 window.postMessage。
 */

declare global { interface Window { __resumeFormAssistantRuntime?: string } }

const CONTENT_RUNTIME = 'hongtu-resume-autofill-2.3.0'
const IS_COORDINATOR = window.top === window

if (window.__resumeFormAssistantRuntime !== CONTENT_RUNTIME) {
  window.__resumeFormAssistantRuntime = CONTENT_RUNTIME

  // ─── 各 frame 共用：扫描 / 填写 / 撤销 ─────────────────────

  let refs = new Map<string, FieldRef>()
  let scannedFields: FormField[] = []
  let undoStack: UndoRecord[] = []
  let lastFingerprints = new Set<string>()
  let hasScanned = false
  /** 插件自己写入期间不把回读当成用户输入。 */
  let learnPaused = false
  let fillEpoch = 0
  const learnState = new Map<string, { timer: number; started: number; ref: FieldRef; picked: string }>()
  /** 点过的单选。页面只改样式、回读仍是旧值时，用这次点中的文字。 */
  const choiceOverride = new Map<string, { text: string; previous: string }>()
  let learnObservers: MutationObserver[] = []
  let fieldWatchInstalled = false
  /** 最近一次点中的下拉、日期或单选。选项弹层挂在 body 上，点击时要靠它认回字段。 */
  let activeLearn: { fingerprint: string; ref: FieldRef } | null = null

  const CHOICE_KINDS = new Set(['radio', 'checkbox', 'select', 'multiselect', 'combobox', 'cascade', 'date'])
  const POPUP_SELECTOR = ['.ant-select-dropdown,.el-select-dropdown,.el-select__popper,.el-picker__popper,.arco-select-dropdown,.arco-trigger-popup,.n-base-select-menu,.ivu-select-dropdown,.semi-select-dropdown,.t-select__dropdown,.t-popup,.ant-picker-dropdown,.ant-picker-panel,.el-picker-panel,.el-time-panel,.arco-picker-panel,[role="listbox"]', PLATFORM_POPUP_SELECTOR].filter(Boolean).join(',')
  const WATCH_WIDGET = ['.ant-select,.el-select,.arco-select,.n-select,.ivu-select,.ant-radio-group,.el-radio-group,.arco-radio-group,.n-radio-group,.ivu-radio-group,.van-radio-group,.t-radio-group,.semi-radio-group,[role="radiogroup"],.ant-picker,.el-date-editor,.arco-picker,.el-time-select,[class*="date-picker"],[class*="time-picker"]', PLATFORM_SELECT_SELECTOR, PLATFORM_DATE_SELECTOR, PLATFORM_RADIO_GROUP_SELECTOR].filter(Boolean).join(',')
  const OPEN_CHOICE = '.ant-select-open,.ant-select-focused,.el-select.is-focused,.ant-picker-focused,.el-date-editor.is-active,.arco-select-open,.arco-picker-focused'
  const OPTION_NODE = ['[role="option"],.ant-select-item-option,.ant-select-item,.el-select-dropdown__item,.arco-select-option,.n-base-select-option,.semi-select-option,.t-select-option,.ivu-select-item,.ant-cascader-menu-item,.el-cascader-node,[class*="select-option"],[class*="dropdown-item"]', PLATFORM_OPTION_SELECTOR].filter(Boolean).join(',')
  const CHOICE_BOX = ['label,.el-radio,.el-radio-button,.el-checkbox,.ant-radio-wrapper,.ant-radio-button-wrapper,.arco-radio,.n-radio,.ivu-radio-wrapper,.van-radio,.t-radio,.semi-radio,[role="radio"],[role="checkbox"]', PLATFORM_CHOICE_WRAPPER_SELECTOR].filter(Boolean).join(',')

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
      scannedFields = output.fields
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
    const nativeField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    if (!nativeField && !looksLikeChoice(target)) return undefined
    const output = scanPage()
    refs = output.refs
    scannedFields = output.fields
    watchLearnedInputs()
    return matchRef(target, refs)
  }

  function clickedElement(event: Event): HTMLElement | null {
    const target = eventElement(event)
    if (!target || target.closest('[data-resume-assistant]')) return null
    return target
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
      const target = clickedElement(event)
      if (!target) return
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
      const target = clickedElement(event)
      if (!target) return
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

  async function frameScan(probeOptions = false): Promise<{ fields: FormField[]; url: string; title: string }> {
    const metadata = Promise.all([
      loadSiteRules().then(rows => rulesForDomain(rows, location.hostname)).catch(() => []),
      loadLearnedAliases().catch(() => [])
    ])
    const output = scanPage()
    refs = output.refs
    scannedFields = output.fields
    if (probeOptions) await probeEmptyChoiceOptions(output.fields, refs).catch(() => undefined)
    const [rules, learnedAliases] = await metadata
    hasScanned = true
    lastFingerprints = new Set(output.fields.map(field => field.fingerprint))
    for (const field of output.fields) {
      field.sectionId = subjectSectionOf(field) || undefined
      const scores = scoreFieldSlots(field, { siteRules: rules, learnedAliases })
      const decision = decideSlot(scores, field.sectionId)
      const qualified = inferQualifiedField(field)
      const highest = decision.candidates[0]
      const hasSemanticSignal = Boolean(highest && (highest.signals.labelMatch || highest.signals.attrAlias || highest.signals.enumSignature))
      const highestCompatible = Boolean(field.sectionId && slotById(highest?.slot || '')?.section === field.sectionId)
      const ambiguousChoice = decision.status === 'ambiguous' && hasSemanticSignal && highestCompatible ? highest?.slot : undefined
      field.slotCandidates = decision.candidates
      field.recordQualifier = qualified?.qualifier
      field.slotStatus = decision.status === 'resolved' || !qualified?.slot ? decision.status : 'resolved'
      field.slot = decision.slot || qualified?.slot || ambiguousChoice
      field.diagnostics = scanDiagnostics(field)
      if (decision.candidates[0]?.signals.learnedAlias) field.learnedAlias = normalize(field.label)
      if (decision.candidates[0]?.signals.siteRule) {
        field.ruleId = findSiteRule(rules, field)?.id
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
    scannedFields = output.fields
    watchLearnedInputs()
    return refs.get(fingerprint)
  }

  function elementsOf(ref: FieldRef): HTMLElement[] {
    if (ref.kind === 'radio') return [...(ref.radios || []), ...(ref.choices || [])]
    if (ref.kind === 'checkbox') {
      const choices: HTMLElement[] = [...(ref.checkboxes || []), ...(ref.choices || [])]
      return choices.length ? choices : [ref.element]
    }
    return [ref.element]
  }

  /** 识别之后持续观察用户在网页上的输入，交给面板整理成知识库候选。 */
  function watchLearnedInputs(): void {
    installFieldWatch()
    for (const observer of learnObservers) observer.disconnect()
    learnObservers = []
    for (const [fingerprint, ref] of refs) {
      if (!CHOICE_KINDS.has(ref.kind)) continue
      const widget = ref.element.closest(WATCH_WIDGET) as HTMLElement | null
      const hosts = new Set<HTMLElement>()
      if (widget) hosts.add(widget)
      for (const shell of choiceObserveRoots(ref)) {
        if (widget?.contains(shell)) continue
        hosts.add(shell)
      }
      if (!hosts.size) hosts.add(choiceGroupOf(ref) || ref.element)
      for (const host of hosts) {
        const observer = new MutationObserver(() => scheduleLearn(fingerprint, ref))
        observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'title', 'value', 'checked', 'aria-checked', 'aria-selected'] })
        learnObservers.push(observer)
      }
    }
  }

  async function frameFill(values: FillRequest[], resetUndo: boolean, runId?: string): Promise<FillResult[]> {
    learnPaused = true
    const epoch = ++fillEpoch
    try {
      if (resetUndo) undoStack = []
      const domain = location.hostname
      const [recipes, strategies, dependencies] = await Promise.all([
        loadFillRecipes(domain).catch(() => []),
        loadInteractionStrategies(domain).catch(() => []),
        loadFieldDependencies(domain).catch(() => [])
      ])
      if (!refs.size) {
        const initial = scanPage()
        refs = initial.refs
        scannedFields = initial.fields
      }
      let optionStates = captureOptionStates(scannedFields)
      const prepared = applyLearnedDependencies(values.map(request => {
        const ref = refs.get(request.fieldId)
        const controlType = ref?.control?.type || ref?.kind || 'unknown'
        return {
          ...request,
          priorValues: priorValuesFor(recipeFor(recipes, request.slot), request.value),
          preferredStrategy: preferredStrategyFor(strategies, request.slot, controlType)
        }
      }), dependencies)
      const results: FillResult[] = []
      // 自动填写只使用页面控件交互，避免浏览器显示调试提示和短暂隐藏助手界面。
      const executions = await executeFillSequence(prepared, fieldId => locateRef(fieldId), undefined, {
        async after(request, execution, ref) {
          if (execution.result.status === 'filled' && execution.undo) {
            undoStack.push(execution.undo)
            highlight(execution.undo.ref, execution.result)
            if (request.slot && execution.result.value) {
              rememberSuccessfulFill(location.hostname, request.slot, request.value, execution.result.value).catch(() => undefined)
            }
          }
          if (runId) {
            if (IS_COORDINATOR) postPanelEvent({ type: 'FILL_PROGRESS', runId, result: { ...execution.result, fieldId: fieldIdOf(0, execution.result.fieldId) } })
            else chrome.runtime.sendMessage({ type: 'FRAME_FILL_PROGRESS', runId, result: execution.result }).catch(() => undefined)
          }
          const controlType = ref?.control?.type || ref?.kind || 'unknown'
          const strategy = successfulStrategy(execution.result)
          const learning: Array<Promise<unknown>> = [recordQualityResult(domain, controlType, execution.result)]
          const preferredFailed = Boolean(request.preferredStrategy && execution.result.trace
            ?.some(step => step.strategy === request.preferredStrategy && step.status === 'failed'))
          if (strategy) learning.push(recordInteractionStrategy(domain, request.slot, controlType, strategy, true))
          if (request.preferredStrategy && preferredFailed && strategy !== request.preferredStrategy) {
            learning.push(recordInteractionStrategy(domain, request.slot, controlType, request.preferredStrategy, false))
          }
          if (request.dependsOn?.length && (execution.result.status === 'filled'
            || execution.result.reasonCode === 'no-matching-option'
            || execution.result.reasonCode === 'option-list-not-found')) {
            learning.push(recordDependencyOutcome(domain, request.fieldId, request.dependsOn, execution.result.status === 'filled'))
          }
          await Promise.all(learning.map(task => task.catch(() => undefined)))
          if (execution.result.status !== 'filled') return
          const parentType = ref?.control?.type || ref?.kind
          if (!['single-choice', 'multi-choice', 'select', 'multi-select', 'cascade', 'radio', 'checkbox', 'combobox', 'multiselect'].includes(parentType || '')) return
          // 父字段回读成功后再观察子字段选项，避免把写入失败当成联动证据。
          await wait(120)
          const rescanned = scanPage()
          const nextStates = captureOptionStates(rescanned.fields)
          const changed = changedOptionFields(optionStates, nextStates, request.fieldId)
          if (changed.length) await recordFieldDependencies(domain, request.fieldId, changed).catch(() => undefined)
          scannedFields = rescanned.fields
          optionStates = nextStates
        }
      })
      watchLearnedInputs()
      for (const execution of executions) results.push(execution.result)
      return results
    } finally {
      window.setTimeout(() => { if (fillEpoch === epoch) learnPaused = false }, 700)
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
      scannedFields = output.fields
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
    const pending = result.source === 'ai' || result.needsReview === true || (result.confidence != null && result.confidence < 0.85)
    for (const element of elementsOf(ref)) {
      element.setAttribute('data-resume-assistant-filled', 'true')
      element.setAttribute('data-resume-assistant-state', pending ? 'pending' : 'confirmed')
      element.setAttribute('title', result.source === 'ai'
        ? `鸿途网申助手：AI 判定语义并已填写（置信度 ${Math.round((result.confidence || 0) * 100)}%）`
        : result.confidence != null && result.confidence < 0.85
          ? `鸿途网申助手：已按最高置信候选填写（${Math.round(result.confidence * 100)}%），请留意`
          : result.needsReview
          ? `鸿途网申助手：已按最匹配选项填写，橙色提示`
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

  async function frameExpand(demands: Array<{ section: string; missing: number }>): Promise<{ clicked: Array<{ section: string; count: number }> }> {
    const clicked: Array<{ section: string; count: number }> = []
    for (const demand of demands) {
      const times = Math.max(0, Math.min(8, demand.missing || 0))
      let count = 0
      for (let index = 0; index < times; index += 1) {
        const output = scanPage()
        const grouped = output.fields.filter(item => item.sectionId === demand.section && item.repeatGroupId)
        const elements = grouped
          .map(field => output.refs.get(field.fingerprint)?.element)
          .filter((element): element is HTMLElement => Boolean(element))
        const before = output.fields.length
        let hit = elements.length ? clickAddForSection(elements) : false
        if (!hit && !grouped.length) {
          const field = output.fields.find(item => item.sectionId === demand.section)
          const ref = field ? output.refs.get(field.fingerprint) : undefined
          hit = Boolean(ref && clickAddNear(ref.element))
        }
        if (!hit) break
        const grew = await pollUntil(() => scanPage().fields.length > before ? true : null, 800)
        if (!grew) break
        count += 1
      }
      if (count) clicked.push({ section: demand.section, count })
    }
    return { clicked }
  }

  chrome.runtime.onMessage.addListener((message: { type: string; values?: FillRequest[]; fieldId?: string; value?: string; sourceFrameId?: number; resetUndo?: boolean; added?: number; probeOptions?: boolean; runId?: string; result?: FillResult; demands?: Array<{ section: string; missing: number }> }, _sender, respond) => {
    if (message.type === 'PANEL_OPEN' && IS_COORDINATOR) {
      mountPanel()
      respond({})
      return false
    }
    if (message.type === 'PANEL_CLOSE' && IS_COORDINATOR) {
      closePanelView()
      respond({})
      return false
    }
    if (message.type === 'FRAME_SCAN') {
      denyUnlessLicensed(respond, () => {
        frameScan(message.probeOptions === true).then(respond).catch(error => respond({ error: String(error) }))
      })
      return true
    }
    if (message.type === 'FRAME_FILL') {
      denyUnlessLicensed(respond, () => {
        frameFill(message.values || [], message.resetUndo !== false, message.runId).then(results => respond({ results })).catch(error => respond({ error: String(error) }))
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
    if (message.type === 'FRAME_EXPAND') {
      denyUnlessLicensed(respond, () => {
        frameExpand(message.demands || []).then(respond).catch(error => respond({ error: String(error) }))
      })
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
    if (message.type === 'FRAME_FILL_PROGRESS' && IS_COORDINATOR && message.result && message.runId) {
      postPanelEvent({ type: 'FILL_PROGRESS', runId: message.runId, result: { ...message.result, fieldId: fieldIdOf(message.sourceFrameId ?? 0, message.result.fieldId) } })
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
  let panelBusy = false
  let fillOverlayHost: HTMLElement | null = null
  let fillOverlayDialog: HTMLElement | null = null
  let trustedInputDepth = 0
  let unsubscribeTrustedInput: (() => void) | null = null
  let fillOverlayHideTimer: number | null = null
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

  async function aggregateScan(probeOptions = false): Promise<{ fields: FormField[]; context: { pageTitle: string; url: string; frames: Array<{ frameId: number; url: string; fieldCount: number }>; platformId?: string; platformName?: string } }> {
    const frameIds = await listFrames()
    const fields: FormField[] = []
    const frames: Array<{ frameId: number; url: string; fieldCount: number }> = []
    let pageTitle = document.title
    const scanned = await Promise.all(frameIds.map(frameId => frameCall<{ fields?: FormField[]; url?: string; title?: string; error?: string } | null>(frameId, { type: 'FRAME_SCAN', probeOptions }).catch(() => null)))
    for (const [index, frameId] of frameIds.entries()) {
      const response = scanned[index]
      if (!response?.fields) continue
      for (const field of response.fields) {
        field.frameId = frameId
        field.id = fieldIdOf(frameId, field.fingerprint)
        fields.push(field)
      }
      frames.push({ frameId, url: response.url || '', fieldCount: response.fields.length })
      if (frameId === 0 && response.title) pageTitle = response.title
    }
    const topPlatform = fields.find(field => field.frameId === 0 && field.platformId) || fields.find(field => field.platformId)
    const platformName = topPlatform?.platformId === 'moka-web' ? 'Moka 招聘'
      : topPlatform?.platformId === 'beisen-phoenix' ? '北森招聘 Phoenix'
        : topPlatform?.platformId === 'beisen-legacy' ? '北森招聘旧版/iTalent'
          : topPlatform?.platformId === 'feishu-jobs' ? '飞书招聘' : undefined
    return { fields, context: { pageTitle, url: location.href, frames, platformId: topPlatform?.platformId, platformName } }
  }

  async function aggregateFill(values: FillRequest[], resetUndo = true, runId?: string): Promise<FillResult[]> {
    const groups = new Map<number, FillRequest[]>()
    for (const request of values) {
      const { frameId, fingerprint } = splitFieldId(request.fieldId)
      const list = groups.get(frameId) || []
      list.push({ ...request, fieldId: fingerprint })
      groups.set(frameId, list)
    }
    // 两阶段填写的第一批必须清空所有 frame 的旧撤销栈；第二批再追加，
    // 这样一次“撤销”能同时恢复身份字段和后续字段。
    if (resetUndo) {
      const frameIds = await listFrames()
      for (const frameId of frameIds.filter(id => !groups.has(id))) {
        await frameCall(frameId, { type: 'FRAME_FILL', values: [], resetUndo: true }).catch(() => null)
      }
    }
    const frameResults = await Promise.all([...groups].map(async ([frameId, group]) => {
      const response = await frameCall<{ results?: FillResult[]; error?: string } | null>(frameId, { type: 'FRAME_FILL', values: group, resetUndo, runId }).catch(() => null)
      return (response?.results || group.map(request => ({ fieldId: request.fieldId, status: 'failed' as const, message: '目标 frame 无响应', reasonCode: 'element-lost' as const })))
        .map(result => ({ ...result, fieldId: fieldIdOf(frameId, result.fieldId) }))
    }))
    return frameResults.flat()
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

  async function aggregateExpand(demands: Array<{ section: string; missing: number }>): Promise<{ clicked: Array<{ section: string; count: number }> }> {
    const frameIds = await listFrames()
    const remaining = demands.map(demand => ({ ...demand }))
    const clicked: Array<{ section: string; count: number }> = []
    for (const frameId of frameIds) {
      const pending = remaining.filter(demand => demand.missing > 0)
      if (!pending.length) break
      const response = await frameCall<{ clicked?: Array<{ section: string; count: number }> } | null>(frameId, { type: 'FRAME_EXPAND', demands: pending }).catch(() => null)
      for (const row of response?.clicked || []) {
        clicked.push(row)
        const demand = remaining.find(item => item.section === row.section)
        if (demand) demand.missing = Math.max(0, demand.missing - row.count)
      }
    }
    return { clicked }
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
      : target.closest<HTMLElement>('input,textarea,select,[role="combobox"],[role="textbox"],[contenteditable="true"]') || target
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
        values: [{ fieldId: fingerprint, value: message.value, intent: 'manual', source: message.source, confidence: message.confidence }],
        resetUndo: false
      }).catch(() => null)
      const result = response?.results?.[0]
      if (result) return { status: 'filled', copied: message.copied !== false, result: { ...result, fieldId: message.fieldId } }
    }
    // 中心字段快速填写：优先最近聚焦的输入框，否则进入拾取模式
    if (lastFocusedFieldId && refs.get(lastFocusedFieldId)?.element.isConnected) {
      const results = await frameFill([{ fieldId: lastFocusedFieldId, value: message.value, intent: 'manual', source: message.source, confidence: message.confidence }], false)
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
      const results = await frameFill([{ fieldId: entry[0], value: message.value, intent: 'manual', source: message.source, confidence: message.confidence }], false)
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

  const LOCKED_INPUT_EVENTS = ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'keydown', 'keyup', 'beforeinput', 'dragstart'] as const

  function blockPageInput(event: Event): void {
    if (!fillOverlayHost || trustedInputDepth > 0 || !event.isTrusted) return
    if (event.cancelable) event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onTrustedInput(active: boolean): void {
    trustedInputDepth = Math.max(0, trustedInputDepth + (active ? 1 : -1))
    if (fillOverlayHost) fillOverlayHost.style.pointerEvents = trustedInputDepth ? 'none' : 'auto'
  }

  function clearFillOverlay(): void {
    if (fillOverlayHideTimer !== null) window.clearTimeout(fillOverlayHideTimer)
    fillOverlayHideTimer = null
    if (!fillOverlayHost) return
    fillOverlayHost.remove()
    fillOverlayHost = null
    fillOverlayDialog = null
    trustedInputDepth = 0
    panelHost?.style.setProperty('pointer-events', 'auto')
    panelFrame?.style.setProperty('pointer-events', 'auto')
    for (const type of LOCKED_INPUT_EVENTS) window.removeEventListener(type, blockPageInput, true)
    unsubscribeTrustedInput?.()
    unsubscribeTrustedInput = null
  }

  function mountFillOverlay(): void {
    if (fillOverlayHost) return
    fillOverlayHost = document.createElement('div')
    fillOverlayHost.id = 'resume-form-assistant-fill-overlay'
    fillOverlayHost.setAttribute('data-resume-assistant', 'fill-overlay')
    fillOverlayHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;'
    const shadow = fillOverlayHost.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; background: rgba(7, 24, 61, .42); backdrop-filter: blur(3px); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
        .dialog { width: min(390px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 15px 22px 21px; border: 1px solid rgba(255,255,255,.95); border-radius: 22px; background: radial-gradient(circle at 50% 8%, #d1e5ff 0, #eff5ff 44%, #fff 100%); box-shadow: 0 18px 55px rgba(5, 31, 84, .28), inset 0 1px 0 #fff; color: #10275a; text-align: center; outline: none; }
        .art { display: block; width: 184px; height: 112px; margin: 0 auto 1px; object-fit: cover; object-position: center; filter: drop-shadow(0 5px 10px rgba(30,105,229,.15)); }
        h2 { margin: 0; font-size: 21px; line-height: 1.35; font-weight: 750; letter-spacing: .02em; }
        .subtitle { margin: 4px 0 17px; color: #65799f; font-size: 12px; }
        .steps { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; margin-bottom: 18px; }
        .steps::before { content: ''; position: absolute; top: 17px; left: 17%; right: 17%; height: 3px; border-radius: 4px; background: #cbd8ee; }
        .step { position: relative; z-index: 1; min-width: 0; }
        .bubble { display: grid; place-items: center; width: 35px; height: 35px; margin: 0 auto 7px; border: 2px solid #fff; border-radius: 50%; background: #d5e0f2; box-shadow: 0 2px 9px rgba(30, 77, 144, .13); color: #61759c; font-size: 15px; font-weight: 700; }
        .step.is-current .bubble { background: linear-gradient(135deg, #275fff, #15b9f3); box-shadow: 0 0 0 5px rgba(63, 154, 255, .16), 0 3px 12px rgba(33, 111, 228, .3); color: #fff; }
        .step.is-done .bubble { background: #2177ee; color: #fff; }
        .step-label { display: block; font-size: 11px; font-weight: 700; white-space: nowrap; }
        .step.is-current .step-label { color: #1269e9; }
        .step-note { display: block; margin-top: 3px; color: #8191af; font-size: 10px; white-space: nowrap; }
        .progress-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 6px; color: #47648f; font-size: 11px; font-weight: 650; }
        .progress-track { height: 8px; overflow: hidden; border-radius: 99px; background: #d9e6f8; }
        .progress-fill { height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, #2b68f9, #18c6ed); transition: width .24s ease; }
        .progress-track.is-indeterminate .progress-fill { width: 36%; animation: glide 1.3s ease-in-out infinite alternate; }
        .detail { min-height: 15px; margin: 9px 0 0; overflow: hidden; color: #7285a7; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
        @keyframes glide { from { transform: translateX(-100%); } to { transform: translateX(280%); } }
        @media (max-height: 370px) { .art { height: 68px; } .subtitle { margin-bottom: 9px; } .steps { margin-bottom: 10px; } }
      </style>
      <div class="backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="fill-overlay-title" aria-describedby="fill-overlay-subtitle" tabindex="-1">
        <img class="art" alt="" />
        <h2 id="fill-overlay-title">正在处理，请稍候</h2>
        <p id="fill-overlay-subtitle" class="subtitle">系统将自动完成识别、检测与填写</p>
        <div class="steps" aria-label="填写阶段">
          <div class="step" data-step="local"><span class="bubble">1</span><span class="step-label">本地识别填写</span><span class="step-note">等待中</span></div>
          <div class="step" data-step="ai"><span class="bubble">2</span><span class="step-label">AI 检测与填写</span><span class="step-note">等待中</span></div>
          <div class="step" data-step="done"><span class="bubble">3</span><span class="step-label">完成</span><span class="step-note">等待中</span></div>
        </div>
        <div class="progress-head"><span class="progress-stage"></span><span class="progress-count"></span></div>
        <div class="progress-track" role="progressbar" aria-label="识别与填写进度"><div class="progress-fill"></div></div>
        <p class="detail" role="status" aria-live="polite"></p>
      </section></div>`
    shadow.querySelector<HTMLImageElement>('.art')!.src = chrome.runtime.getURL('assets/ui/ai-processing.png')
    fillOverlayDialog = shadow.querySelector<HTMLElement>('.dialog')
    document.documentElement.append(fillOverlayHost)
    panelHost?.style.setProperty('pointer-events', 'none')
    panelFrame?.style.setProperty('pointer-events', 'none')
    for (const type of LOCKED_INPUT_EVENTS) window.addEventListener(type, blockPageInput, { capture: true, passive: false })
    unsubscribeTrustedInput = subscribeTrustedInput(onTrustedInput)
    fillOverlayDialog?.focus({ preventScroll: true })
  }

  function updateFillOverlay(state: FillOverlayState | null): void {
    if (!state) { clearFillOverlay(); return }
    if (fillOverlayHideTimer !== null) window.clearTimeout(fillOverlayHideTimer)
    fillOverlayHideTimer = null
    mountFillOverlay()
    // 关闭的 shadow root 通过 dialog 引用继续访问，页面脚本不能改写弹窗内容。
    const root = fillOverlayDialog?.parentElement
    if (!root) return
    const finished = state.phase === 'done'
    const localDone = state.phase === 'ai' || finished
    root.querySelector<HTMLElement>('#fill-overlay-title')!.textContent = finished ? '处理结束' : '正在处理，请稍候'
    for (const name of ['local', 'ai', 'done'] as const) {
      const step = root.querySelector<HTMLElement>(`[data-step="${name}"]`)
      if (!step) continue
      const active = name === 'local' ? !localDone : name === 'ai' ? state.phase === 'ai' : finished
      const complete = name === 'local' && localDone || name === 'ai' && finished && state.aiTotal > 0
      step.classList.toggle('is-current', active)
      step.classList.toggle('is-done', complete)
      step.querySelector<HTMLElement>('.bubble')!.textContent = complete ? '✓' : name === 'local' ? '1' : name === 'ai' ? '2' : '3'
      step.querySelector<HTMLElement>('.step-note')!.textContent = complete
        ? '已完成' : name === 'ai' && finished ? '未启用' : active ? finished ? '已结束' : '进行中' : '等待中'
    }
    const scanning = state.phase === 'scan'
    const current = localDone ? state.aiAnalyzed : state.processed
    const total = localDone ? state.aiTotal : state.total
    const percent = finished ? 100 : total > 0 ? Math.min(100, Math.round(current / total * 100)) : 0
    root.querySelector<HTMLElement>('.progress-stage')!.textContent = finished ? '本轮处理已结束' : scanning ? '正在扫描表单' : localDone ? 'AI 已处理字段' : '本地已处理字段'
    root.querySelector<HTMLElement>('.progress-count')!.textContent = finished ? '完成' : scanning ? '读取中' : total ? `${current} / ${total}` : '准备中'
    const track = root.querySelector<HTMLElement>('.progress-track')!
    track.classList.toggle('is-indeterminate', !finished && (scanning || total === 0))
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', String(total || 100))
    if (finished) track.setAttribute('aria-valuenow', String(total || 100))
    else if (total && !scanning) track.setAttribute('aria-valuenow', String(Math.min(current, total)))
    else track.removeAttribute('aria-valuenow')
    root.querySelector<HTMLElement>('.progress-fill')!.style.width = !finished && (scanning || total === 0) ? '' : `${percent}%`
    root.querySelector<HTMLElement>('.detail')!.textContent = state.status
    if (finished) fillOverlayHideTimer = window.setTimeout(clearFillOverlay, 550)
  }

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
    clearFillOverlay()
    panelBusy = false
    panelHost?.remove()
    panelHost = null
    panelFrame = null
  }

  function closePanelManually(): void {
    closePanelView()
    chrome.runtime.sendMessage({ type: 'PANEL_VISIBILITY_CHANGED', open: false }).catch(() => undefined)
  }

  function mountPanel(): void {
    if (panelHost) {
      // 后台可能在首次注入完成后、或多个 onUpdated 事件中重复要求显示。
      // 这里必须幂等，不能把重复的“打开”误当成切换并再次隐藏。
      panelHost.hidden = false
      requestAnimationFrame(ensurePanelInViewport)
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
    if (!panelHost || !panelFrame || panelBusy) return
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

  async function handlePanelMessage(message: { type: string; values?: FillRequest[]; fieldId?: string; value?: string; source?: FillRequest['source']; confidence?: number; copied?: boolean; probeOptions?: boolean; resetUndo?: boolean; runId?: string; demands?: Array<{ section: string; missing: number }> }): Promise<unknown> {
    if (!(await loadLicense())) return { error: LICENSE_REQUIRED_MESSAGE }
    if (message.type === 'SCAN') return aggregateScan(message.probeOptions === true)
    if (message.type === 'VISUAL_STATUS') return warmupVisualAssist()
    if (message.type === 'EXPAND_REPEATS') return aggregateExpand(message.demands || [])
    if (message.type === 'FILL') return aggregateFill(message.values || [], message.resetUndo !== false, message.runId).then(results => ({ results }))
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
      const { requestId, message } = event.data as { requestId: string; message: { type: string; mode?: 'compact' | 'expanded' | 'activation'; clientX?: number; clientY?: number; busy?: boolean; state?: FillOverlayState | null } }
      if (message.type === 'SET_PANEL_BUSY') { panelBusy = message.busy === true; if (panelBusy) stopPanelDrag?.(); return }
      if (message.type === 'SET_FILL_OVERLAY') { updateFillOverlay(message.state || null); return }
      if (panelBusy && ['CLOSE_PANEL', 'MINIMIZE_PANEL', 'RESIZE_PANEL', 'DRAG_PANEL'].includes(message.type)) return
      if (message.type === 'CLOSE_PANEL') { closePanelManually(); return }
      if (message.type === 'MINIMIZE_PANEL') { closePanelView(); return }
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
  }
}
