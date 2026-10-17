<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { polishText, suggestSlotMatches } from '../../application/api'
import { buildFactIndex, fieldsNeedingAi, isPreviewFillable, resolveField, type FactIndex } from '../../features/autofill/dataResolver'
import { factToSlot } from '../../features/autofill/match/factToSlot'
import { aliasHit, aliasSectionCount, slotById } from '../../features/ontology/slotRegistry'
import { looksLikeFieldPrompt, plainChoiceText } from '../../features/ontology/optionMatch'
import { compareSemanticValues, semanticValuesMatch } from '../../features/ontology/valueSemantics'
import { dropCachedSuggestion, getCachedSuggestions, putCachedSuggestions } from '../../features/ai/slotMatchCache'
import { learnAlias, loadLearnedAliases, recordAliasFailure, recordAliasHit } from '../../features/ontology/learnedAliases'
import { sectionOfText } from '../../features/ontology/sections'
import { planRepeatExpansion } from '../../features/autofill/scan/repeatExpand'
import { classifyPageInput, knowledgeIdentity, mergeIntoKnowledge, type LearnedEntry } from '../../features/rag/knowledge'
import { isLearnedDismissed, learnedDismissKey } from '../../features/rag/learnedDismiss'
import { alignFamilyItem, familyItemForRelation, isFamilyField, isRelationField, relationKey } from '../../features/autofill/familyAlign'
import { alignNamedItem, dateSlotId, fillNamedItem, nameSlotId, namedSectionOf } from '../../features/autofill/namedSegment'
import { pageSegmentItem, samePageSegment } from '../../features/autofill/pageSegment'
import { bindObservedRepeatRecords, bindRepeatRecords } from '../../features/autofill/repeatBinding'
import { splitIdentityFillRequests } from '../../features/autofill/fillPhases'
import { recordCorrection, recordFailure, recordHit, recordObservation } from '../../features/siteRules/ruleStore'
import { beginPanelDrag, closePanel, onContentEvent, requestContent, resizePanel, setFillOverlay, setPanelBusy } from '../bridge/panelBridge'
import { loadAiSettings, loadCurrentResume, loadProfile, saveProfile } from '../../infrastructure/storage/store'
import { activate, loadLicense, type LicenseRecord } from '../../features/license/license'
import type { AiSettings, CurrentResume, Fact, FillRequest, FillResult, FormField, LearnedAlias, PageContext, ResolvedField, SlotSuggestion } from '../../domain/types'
import OptionsApp from './OptionsApp.vue'
import { mergeFactsByPriority } from '../../features/autofill/factPriority'
import { fullFieldDiagnostics, resolutionDiagnostics, summarizeFunnel } from '../../features/autofill/diagnostics/trace'
import { buildRegressionFixture } from '../../features/autofill/diagnostics/regressionFixture'
import { loadQualityMetrics } from '../../features/autofill/learning/qualityMetrics'
import { planValueBindings } from '../../features/autofill/bindingPlanner'

const facts = ref<Fact[]>([])
const learnedAliasRows = ref<LearnedAlias[]>([])
const currentResume = ref<CurrentResume | null>(null)
const aiSettings = ref<AiSettings>({ url: '', key: '', model: '' })
const fields = ref<FormField[]>([])
const selections = reactive<Record<string, string>>({})
const results = reactive<Record<string, FillResult>>({})
const resolutions = reactive<Record<string, ResolvedField>>({})
const aiSuggestions = reactive<Record<string, SlotSuggestion>>({})
const status = ref('打开网申页面后，点击“识别当前页面”。')
const busy = ref(false)
const selectedPolishField = ref('')
const jobDescription = ref('')
const maxLength = ref(300)
const suggestion = ref('')
const polished = ref(false)
const pageContext = ref<PageContext | null>(null)
const newFieldsHint = ref(0)
const visualHealth = ref<{ checking: boolean; ready: boolean; ocrAvailable: boolean; aiAvailable: boolean; aiVerified: boolean; aiRejected: boolean; error?: string }>({
  checking: false, ready: false, ocrAvailable: false, aiAvailable: false, aiVerified: false, aiRejected: false
})
/**
 * 网页学习候选：自动观察网页上的填写得出。
 * supplement = 插件没填、用户补充的；correction = 插件填了、用户改过的。
 * 确认前可在线编辑 value，确认后才写入知识库。
 */
const learned = ref<Array<LearnedEntry & { selected: boolean; origin: 'supplement' | 'correction'; previous: string; fieldId: string; pageValue?: string }>>([])
/** 有值但无法唯一绑定到某一条重复记录的字段数；这类字段必须阻止更新并明确提示。 */
const unresolvedObservedCount = ref(0)
/** 本次填写会话里放弃过的字段页面值。不写入存储，重新识别或重新读取后清空。 */
const dismissedLearned = new Set<string>()
const learnedListEl = ref<HTMLElement | null>(null)
/** 用户还停在列表底部时，新记录才跟着滚下去。往上翻之后不再拽回来。 */
let learnedPinned = true
let suppressLearnedScroll = false
const revealedLearned = new Set<string>()
const featureSettings = reactive({ autoClipboard: true, aiMapping: true, debugMode: false, miniPanel: true, aiMatchThreshold: 85 })
const selectedField = computed(() => fields.value.find(field => field.id === selectedPolishField.value))
const polishableFields = computed(() => fields.value.filter(field => field.kind === 'textarea'
  || /自我评价|个人优势|自我介绍|职业目标|工作内容|项目描述|职责|description|summary/i.test(`${field.label} ${field.placeholder}`)))

const aiReady = computed(() => Boolean(aiSettings.value.url && aiSettings.value.key && aiSettings.value.model))
const visualHealthText = computed(() => {
  if (visualHealth.value.checking) return '视觉自动点击已关闭 · 正在检查本地 OCR…'
  if (!visualHealth.value.ocrAvailable) return `视觉自动点击已关闭 · 本地 OCR 不可用${visualHealth.value.error ? `（${visualHealth.value.error}）` : ''}`
  if (!visualHealth.value.aiAvailable) return '视觉自动点击已关闭 · OCR 已就绪'
  if (visualHealth.value.aiVerified) return '视觉自动点击已关闭 · OCR 与图片能力已就绪'
  if (visualHealth.value.aiRejected) return '视觉自动点击已关闭 · 图片能力测试失败'
  return '视觉自动点击已关闭 · OCR 已就绪，图片能力未验证'
})
// 知识库（我的信息）是唯一填充数据源
const allFacts = computed(() => mergeFactsByPriority(facts.value))
const factIndex = computed<FactIndex>(() => buildFactIndex(facts.value))
const repeatRecordBindings = computed(() => bindRepeatRecords(fields.value, allFacts.value, {
  legacyWorkFallback: !fields.value.some(field => field.sectionId === 'internship' || sectionOfText(field.group) === 'internship')
}))
const pickerActive = ref(false)
const expanded = ref(false)
const showingControl = ref(false)
const controlView = ref<'home' | 'resume' | 'profile' | 'assist' | 'settings'>('home')
const license = ref<LicenseRecord | null>(null)
const licenseChecked = ref(false)
const activationCode = ref('')
const activationError = ref('')
const activating = ref(false)
const autoFillRunning = ref(false)
const fillProgress = reactive({ phase: 'idle' as 'idle' | 'scan' | 'local' | 'ai' | 'done', processed: 0, total: 0, aiAnalyzed: 0, aiTotal: 0 })
watch(() => [autoFillRunning.value, fillProgress.phase, fillProgress.processed, fillProgress.total,
  fillProgress.aiAnalyzed, fillProgress.aiTotal, status.value] as const, () => {
  if (!autoFillRunning.value || fillProgress.phase === 'done' || fillProgress.phase === 'idle') return
  setFillOverlay({
    phase: fillProgress.phase,
    processed: fillProgress.processed,
    total: fillProgress.total,
    aiAnalyzed: fillProgress.aiAnalyzed,
    aiTotal: fillProgress.aiTotal,
    status: status.value
  })
}, { flush: 'post' })
let activeFillRunId = ''
const processedFillIds = new Set<string>()
const matchedCount = computed(() => Object.values(resolutions).filter(item => item.status === 'ready' || item.status === 'needs-confirmation').length)

/** 结果报告四分类（F51）：已填写 / 原值保留 / 待确认 / 失败。 */
const report = computed(() => {
  const rows = Object.values(results)
  return {
    filled: rows.filter(row => row.status === 'filled'),
    kept: rows.filter(row => row.status === 'skipped'),
    pending: fields.value.filter(field => resolutions[field.id]?.status === 'needs-confirmation' && !results[field.id]),
    failed: rows.filter(row => row.status === 'failed')
  }
})

const diagnosticFunnel = computed(() => summarizeFunnel(fields.value, resolutions, results))

/**
 * 自动填写把本页能写的字段写完之后才为 true。
 * 为 false 时不吸收、不保存网页上的修改。
 */
const knowledgeWatch = ref(false)

const FIELD_REVIEW_TABS = [
  { id: 'pending', label: '未填写' },
  { id: 'confirmed', label: '已匹配' },
  { id: 'filled', label: '已填写' },
  { id: 'failed', label: '填写失败' },
  { id: 'kept', label: '原值保留' },
  { id: 'empty', label: '无数据' }
] as const

type FieldReviewTab = typeof FIELD_REVIEW_TABS[number]['id']

/** 按匹配和填写状态归类：待确认、已确认、已填写等，同一字段只进一个标签。 */
function fieldReviewBucket(field: FormField): FieldReviewTab {
  const result = results[field.id]
  if (result?.status === 'failed') return 'failed'
  if (result?.status === 'filled') return 'filled'
  if (result?.status === 'skipped') return 'kept'
  const resolution = resolutions[field.id]
  if (!resolution || resolution.status === 'empty') return 'empty'
  if (resolution.status === 'needs-confirmation') return 'pending'
  if (resolution.status === 'ready') return 'confirmed'
  if (resolution.status === 'skipped') return 'kept'
  return 'empty'
}

function fieldNeedsAttention(field: FormField): boolean {
  const result = results[field.id]
  return result?.status === 'filled' && (result.source === 'ai' || result.needsReview === true
    || (result.confidence != null && result.confidence < 0.85))
}

const fieldTabs = computed(() => {
  const buckets = new Map<FieldReviewTab, FormField[]>(FIELD_REVIEW_TABS.map(tab => [tab.id, []]))
  for (const field of fields.value) buckets.get(fieldReviewBucket(field))!.push(field)
  return FIELD_REVIEW_TABS.map(tab => ({ ...tab, rows: buckets.get(tab.id) || [] })).filter(tab => tab.rows.length > 0)
})
const activeFieldTab = ref<FieldReviewTab | ''>('')
const activeTab = computed(() => fieldTabs.value.find(tab => tab.id === activeFieldTab.value) || fieldTabs.value[0] || null)

let removeContentEvents: (() => void) | null = null
let removeSettingsEvents: (() => void) | null = null

function tagFacts(rows: Fact[], source: 'profile' | 'resume'): Fact[] {
  return rows.map(row => ({ ...row, source }))
}

function pageDomain(): string {
  try { return pageContext.value?.url ? new URL(pageContext.value.url).hostname : '' } catch { return '' }
}

onMounted(async () => {
  resizePanel('compact')
  license.value = await loadLicense()
  licenseChecked.value = true
  if (!license.value) resizePanel('activation')
  facts.value = tagFacts((await loadProfile()).facts, 'profile')
  learnedAliasRows.value = await loadLearnedAliases()
  currentResume.value = await loadCurrentResume()
  aiSettings.value = await loadAiSettings()
  const storedFeatures = await chrome.storage.local.get('featureSettingsV1')
  if (storedFeatures.featureSettingsV1) Object.assign(featureSettings, storedFeatures.featureSettingsV1)
  const settingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.featureSettingsV1?.newValue) Object.assign(featureSettings, changes.featureSettingsV1.newValue)
    if (area === 'local' && changes.aiSettingsV1) {
      void loadAiSettings().then(settings => { aiSettings.value = settings })
      void refreshVisualHealth()
    }
    if (area === 'local' && changes.visualCapabilityV1) void refreshVisualHealth()
  }
  chrome.storage.onChanged.addListener(settingsChanged)
  removeSettingsEvents = () => chrome.storage.onChanged.removeListener(settingsChanged)
  removeContentEvents = onContentEvent(event => {
    if (event?.type === 'FILL_PROGRESS') {
      if (event.runId === activeFillRunId && event.result) {
        results[event.result.fieldId] = event.result
        updateFillProgress(event.result)
      }
      return
    }
    if (event?.type === 'PAGE_MUTATED') {
      // F16：只提示不动作
      newFieldsHint.value = event.added || 0
      return
    }
    if (event?.type === 'FIELD_OBSERVED') {
      if (!knowledgeWatch.value) return
      // 单字段事件只用于唤醒；实际判断统一读取整页快照，避免名称/关系字段读取较晚导致串段。
      void pollLearned()
      return
    }
    if (event?.type !== 'PICKER_RESULT') return
    pickerActive.value = false
    if (event.result) results[event.result.fieldId] = event.result
    status.value = event.result?.status === 'filled' ? '已完成手动辅助填写，并复制到剪贴板。' : event.result?.message || '手动辅助填写失败。'
  })
  if (!license.value) return
  if (!featureSettings.miniPanel) openControl('home')
  void refreshVisualHealth()
  await scan()
})

onUnmounted(() => {
  stopLearnedWatch()
  if (autoFillRunning.value) {
    setFillOverlay(null)
    setPanelBusy(false)
  }
  removeContentEvents?.()
  removeSettingsEvents?.()
})

async function submitActivation() {
  activationError.value = ''
  activating.value = true
  try {
    license.value = await activate(activationCode.value)
    activationCode.value = ''
    if (!featureSettings.miniPanel) openControl('home')
    else resizePanel('compact')
    void refreshVisualHealth()
    await scan()
  } catch (error) {
    activationError.value = error instanceof Error ? error.message : '激活失败'
  } finally {
    activating.value = false
  }
}

function onLicenseCleared() {
  license.value = null
  showingControl.value = false
  expanded.value = false
  resizePanel('activation')
}

function openControl(view: 'home' | 'resume' | 'profile' | 'assist' | 'settings' = 'home') {
  controlView.value = view
  showingControl.value = true
  expanded.value = false
  resizePanel('expanded')
}

async function refreshVisualHealth(): Promise<void> {
  visualHealth.value = { ...visualHealth.value, checking: true }
  try {
    const response = await requestContent<{ ready?: boolean; ocrAvailable?: boolean; aiAvailable?: boolean; aiVerified?: boolean; aiRejected?: boolean; error?: string }>({ type: 'VISUAL_STATUS' })
    visualHealth.value = {
      checking: false,
      ready: response.ready === true,
      ocrAvailable: response.ocrAvailable === true,
      aiAvailable: response.aiAvailable === true,
      aiVerified: response.aiVerified === true,
      aiRejected: response.aiRejected === true,
      error: response.error
    }
  } catch (error) {
    visualHealth.value = {
      checking: false, ready: false, ocrAvailable: false, aiAvailable: false, aiVerified: false, aiRejected: false,
      error: error instanceof Error ? error.message : '状态检查失败'
    }
  }
}

function openFillView() { showingControl.value = false; expanded.value = true; resizePanel('expanded') }
function openCompactView() { showingControl.value = false; expanded.value = false; resizePanel('compact') }
function dragFromHeader(event: PointerEvent) {
  if (autoFillRunning.value) return
  if ((event.target as HTMLElement).closest('button, input, textarea, a')) return
  event.preventDefault()
  beginPanelDrag(event.clientX, event.clientY)
}

function familyPeers(field: FormField): FormField[] {
  if (!isFamilyField(field)) return []
  return fields.value.filter(other => {
    if (!isFamilyField(other)) return false
    return samePageSegment(field, other, fields.value)
  })
}

/** 这一段页面上已经写出的称谓（关系框、或区块标题里的父亲/母亲）。认不出则返回空。 */
function segmentRelation(field: FormField, override?: { id: string; value: string }): string {
  const peers = familyPeers(field)
  const relationField = peers.find(isRelationField)
  const raw = relationField
    ? (override?.id === relationField.id ? override.value : '') || relationField.current
    : ''
  const fromField = relationKey(raw)
  if (fromField) return fromField
  return relationKey(field.group)
}

/**
 * 有称谓时返回知识库里这个人的条目号。
 * 页面写了称谓但知识库没有这个人时返回 null，调用方留空，避免填到另一段上。
 */
function familySegmentItem(field: FormField, override?: { id: string; value: string }): number | null | undefined {
  if (!isFamilyField(field)) return undefined
  const relation = segmentRelation(field, override)
  if (!relation) return pageSegmentItem(field, fields.value)
  return familyItemForRelation(allFacts.value, relation) ?? null
}

function namedPeers(field: FormField): FormField[] {
  const section = namedSectionOf(field)
  if (!section) return []
  return fields.value.filter(other => {
    if (namedSectionOf(other) !== section) return false
    return samePageSegment(field, other, fields.value)
  })
}

/** 这一段页面上的名称或时间。名称栏不存在时 present 为 false。 */
function anchorOnPage(field: FormField, slotId: string, override?: { id: string; value: string }): { present: boolean; value: string } {
  const slot = slotById(slotId)
  const hits = namedPeers(field).filter(peer => peer.slot === slotId || Boolean(slot && aliasHit(slot, peer.label)))
  if (!hits.length) return { present: false, value: '' }
  const value = hits.map(peer => (override?.id === peer.id ? override.value : peer.current).trim()).find(Boolean) || ''
  return { present: true, value }
}

function namedAlignInput(field: FormField, override?: { id: string; value: string }) {
  const section = namedSectionOf(field)
  if (!section) return null
  const name = anchorOnPage(field, nameSlotId(section), override)
  const date = anchorOnPage(field, dateSlotId(section), override)
  return {
    section,
    pageItem: pageSegmentItem(field, fields.value),
    name: name.present ? name.value : undefined,
    date: date.value,
    facts: allFacts.value
  }
}

/** 填写时按名称对齐。不是按名称对齐的板块时返回 undefined，沿用页面段号。 */
function namedSegmentItem(field: FormField): number | null | undefined {
  const input = namedAlignInput(field)
  if (!input) return undefined
  const aligned = fillNamedItem(input)
  return aligned === undefined ? input.pageItem : aligned
}

/**
 * 名称后来填上、对上知识库已有的一段时，把这一段里还没保存的字段改到那一段。
 * 对上之后值和知识库一样的，从待确认列表拿掉。
 */
function realignNamedLearned(field: FormField, item: number): void {
  const ids = new Set(namedPeers(field).map(peer => peer.id))
  learned.value = learned.value.flatMap(row => {
    if (!ids.has(row.fieldId) || row.fieldId === field.id) return [row]
    const next = { ...row, fact: { ...row.fact, item } }
    const existing = allFacts.value.find(fact => knowledgeIdentity(fact) === knowledgeIdentity(next.fact))
    const slot = factToSlot(next.fact).slot
    if (existing && semanticValuesMatch(existing.value, next.fact.value, { slot: slot ? slotById(slot) : undefined })) return []
    next.previous = existing?.value || ''
    return [next]
  })
}

function pageHasSection(section: string): boolean {
  return fields.value.some(field => field.sectionId === section || sectionOfText(field.group) === section)
}

function resolveOne(field: FormField): void {
  const repeatItems = repeatRecordBindings.value
  const boundItem = repeatItems.has(field.id) ? repeatItems.get(field.id) : undefined
  const resolved = resolveField(field, factIndex.value, {
    aiSuggestion: aiSuggestions[field.id],
    aiMatchThreshold: featureSettings.aiMatchThreshold,
    segmentItem: boundItem !== undefined
      ? boundItem
      : isFamilyField(field) ? familySegmentItem(field) : namedSegmentItem(field),
    legacyWorkFallback: !pageHasSection('internship')
  })
  const bestLocal = field.slotCandidates?.[0]
  if (field.slotStatus === 'ambiguous' && bestLocal && bestLocal.slot === resolved.slot && resolved.value) {
    resolved.confidence = Math.min(resolved.confidence, bestLocal.score, 0.8)
    resolved.reason = `已选择本地得分最高的字段含义；${resolved.reason}`
  }
  resolved.diagnostics = resolutionDiagnostics(field, resolved)
  resolutions[field.id] = resolved
  selections[field.id] = resolved.factId && (resolved.status === 'ready' || resolved.status === 'needs-confirmation') ? resolved.factId : ''
}

async function autoFill() {
  if (autoFillRunning.value) return
  autoFillRunning.value = true
  setPanelBusy(true)
  activeFillRunId = `fill-${Date.now()}-${Math.random().toString(36).slice(2)}`
  processedFillIds.clear()
  Object.assign(fillProgress, { phase: 'scan', processed: 0, total: 0, aiAnalyzed: 0, aiTotal: 0 })
  status.value = '正在准备自动填写…'
  try {
    await runAutoFill()
  } catch (error) {
    status.value = error instanceof Error ? error.message : '自动填写失败。'
  } finally {
    fillProgress.phase = 'done'
    setFillOverlay({ phase: 'done', processed: fillProgress.processed, total: fillProgress.total,
      aiAnalyzed: fillProgress.aiAnalyzed, aiTotal: fillProgress.aiTotal, status: status.value })
    activeFillRunId = ''
    autoFillRunning.value = false
    setPanelBusy(false)
  }
}

function updateFillProgress(result: FillResult): void {
  if (processedFillIds.has(result.fieldId)) return
  processedFillIds.add(result.fieldId)
  fillProgress.processed = [...processedFillIds].filter(id => fields.value.some(field => field.id === id)).length
}

async function runAutoFill() {
  // 流水线式流式填写：扫描 → 本地已匹配立即填 → AI 分批，每批返回即填，不空等整轮分析。
  // 这一轮写完之前不监测网页修改，避免把填写过程本身学进知识库。
  knowledgeWatch.value = false
  learned.value = []
  dismissedLearned.clear()
  if (!await scan({ expandRepeats: false })) return
  if (!fields.value.length) { status.value = '当前页面没有发现可填写的表单字段。'; return }

  fillProgress.phase = 'local'
  fillProgress.total = fields.value.length

  busy.value = true
  let filledTotal = 0
  let failure = ''
  let aiSummary: AiPassSummary | undefined
  let firstFill = true
  const notFilled = (field: FormField) => results[field.id]?.status !== 'filled'
  const countFilled = (rows: FillResult[]) => rows.filter(row => row.status === 'filled').length

  // 填当前所有已就绪、尚未填过的字段。身份字段写入后重扫长出的重复段。
  const flushReady = async (fieldIds?: ReadonlySet<string>): Promise<void> => {
    const targets = () => fields.value.filter(field => notFilled(field) && (!fieldIds || fieldIds.has(field.id)))
    const values = fillRequests(targets())
    if (!values.length) return
    const phases = splitIdentityFillRequests(values, fields.value)
    if (phases.identity.length) {
      status.value = `正在先填写 ${phases.identity.length} 个记录身份字段…`
      filledTotal += countFilled(await sendFillRequests(phases.identity, firstFill))
      firstFill = false
      // AI 也可能在第二轮才认出身份字段；每次身份写入后保留 AI 建议并重扫。
      await refreshAutoFillFields()
      const rest = fillRequests(targets())
      if (rest.length) {
        status.value = `身份字段已填，正在流式填写其余 ${rest.length} 个字段…`
        filledTotal += countFilled(await sendFillRequests(rest, false))
      }
      return
    }
    filledTotal += countFilled(await sendFillRequests(values, firstFill))
    firstFill = false
  }

  try {
    await flushReady() // 本地已匹配：立即填
    if (planRepeatExpansion(fields.value, allFacts.value).length) {
      status.value = '正在补充页面上的重复经历段…'
      if (await expandRepeatsIfNeeded()) {
        await refreshAutoFillFields()
        await flushReady()
      }
    }
    if (featureSettings.aiMapping) {
      aiSettings.value = await loadAiSettings()
    }
    if (featureSettings.aiMapping && aiReady.value) {
      fillProgress.phase = 'ai'
      aiSummary = await aiMatchStreaming(flushReady) // AI 分批：每批返回即填
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : '填写失败。'
  } finally {
    busy.value = false
  }

  knowledgeWatch.value = true
  learned.value = []
  const aiNote = aiSummary?.failedBatches ? `AI 有 ${aiSummary.failedBatches} 批失败：${aiSummary.firstError}。` : ''
  status.value = failure ? `已填写 ${filledTotal} 项；后续步骤失败：${failure}` : filledTotal > 0
    ? `已流式填写 ${filledTotal} 项。${aiNote}橙色标记为投影或低置信匹配，请留意。正在监测你之后的修改。`
    : aiSummary?.failedBatches ? `${aiNote}本次没有成功填入字段，仍可重试。正在监测。`
      : featureSettings.aiMapping && !aiReady.value
        ? '本地未找到可填写字段；配置 AI 后可补充识别。正在监测。'
        : '没有可填写的字段：知识库中没有与本页字段对应的数据，请先完善「我的信息」。正在监测。'
}

async function refreshAutoFillFields(): Promise<void> {
  const again = await requestContent({ type: 'SCAN', probeOptions: false })
  if (again.error) throw new Error(again.error)
  const kept = { ...results }
  const suggested = new Map<string, { fingerprint: string; suggestion: SlotSuggestion }>()
  for (const field of fields.value) {
    const suggestion = aiSuggestions[field.id]
    if (suggestion) suggested.set(field.id, { fingerprint: field.fingerprint, suggestion })
  }
  applyScan(again)
  for (const field of fields.value) {
    const previous = suggested.get(field.id)
    if (previous?.fingerprint === field.fingerprint) {
      aiSuggestions[field.id] = previous.suggestion
      resolveOne(field)
    }
  }
  for (const [id, row] of Object.entries(kept)) {
    if (fields.value.some(field => field.id === id)) results[id] = row
  }
  fillProgress.total = fields.value.length
  fillProgress.processed = [...processedFillIds].filter(id => fields.value.some(field => field.id === id)).length
}

async function startAutoFillFromHome() {
  showingControl.value = false
  expanded.value = false
  resizePanel('compact')
  await autoFill()
}

function applyScan(response: { fields?: FormField[]; context?: PageContext | null }): void {
  fields.value = response.fields || []
  pageContext.value = response.context || null
  for (const record of [aiSuggestions, resolutions, selections, results]) {
    for (const key of Object.keys(record)) delete record[key]
  }
  for (const field of fields.value) resolveOne(field)
}

/** 档案段数多于页面块数时，点「新增一段」再扫一次。只补一轮。 */
async function expandRepeatsIfNeeded(): Promise<number> {
  const demands = planRepeatExpansion(fields.value, allFacts.value)
  if (!demands.length) return 0
  const response = await requestContent({ type: 'EXPAND_REPEATS', demands })
  if (response.error) return 0
  const rows = (response.clicked || []) as Array<{ count: number }>
  return rows.reduce((sum, row) => sum + (row.count || 0), 0)
}

async function scan(options: { probeOptions?: boolean; expandRepeats?: boolean } = {}): Promise<boolean> {
  busy.value = true
  status.value = '正在读取当前页面…'
  fields.value = []
  suggestion.value = ''
  newFieldsHint.value = 0
  learned.value = []
  dismissedLearned.clear()
  try {
    const [profile, response] = await Promise.all([
      loadProfile(),
      requestContent({ type: 'SCAN', probeOptions: options.probeOptions === true })
    ])
    facts.value = tagFacts(profile.facts, 'profile')
    if (response.error) throw new Error(response.error)
    applyScan(response)
    let added = 0
    if (options.expandRepeats !== false && planRepeatExpansion(fields.value, allFacts.value).length) {
      status.value = '档案里的经历比页面上多，正在补行…'
      added = await expandRepeatsIfNeeded()
      if (added) {
        const again = await requestContent({ type: 'SCAN', probeOptions: options.probeOptions === true })
        if (again.error) throw new Error(again.error)
        applyScan(again)
      }
    }
    const ready = Object.values(resolutions).filter(item => item.status === 'ready').length
    const pending = Object.values(resolutions).filter(item => item.status === 'needs-confirmation').length
    const frames = pageContext.value?.frames?.length || 1
    const addedNote = added ? `已自动补充 ${added} 段。` : ''
    status.value = `识别 ${fields.value.length} 个字段（${frames > 1 ? `${frames} 个 frame，` : ''}可填写 ${ready} 个，未填写 ${pending} 个）。${addedNote}`
    return true
  } catch (error) { status.value = error instanceof Error ? error.message : '页面识别失败。'; return false }
  finally { busy.value = false }
}

type AiPassSummary = { analyzed: number; matched: number; failedBatches: number; firstError: string }

/** 相同板块的字段放在一起，让每个 AI 请求只携带相关知识。 */
function aiFieldChunks(pending: FormField[], batchSize = 6): FormField[][] {
  const groups = new Map<string, FormField[]>()
  for (const field of pending) {
    const section = field.sectionId || sectionOfText(field.group) || 'unknown'
    const group = groups.get(section) || []
    group.push(field)
    groups.set(section, group)
  }
  return [...groups.values()].flatMap(group => {
    const chunks: FormField[][] = []
    for (let index = 0; index < group.length; index += batchSize) chunks.push(group.slice(index, index + batchSize))
    return chunks
  })
}

function aiFactsForChunk(chunk: FormField[], knowledge: Fact[]): Fact[] {
  const section = chunk[0]?.sectionId || sectionOfText(chunk[0]?.group || '')
  if (!section) return knowledge
  const related = knowledge.filter(fact => {
    const factSection = sectionOfText(fact.group)
    return factSection === section || (section === 'work' && factSection === 'internship')
  })
  return related.length ? related : knowledge
}

/** 缓存优先；AI 请求最多两个并发，每批返回即排队校验与写入。 */
async function aiMatchStreaming(onBatchResolved: (fieldIds: ReadonlySet<string>) => Promise<void>): Promise<AiPassSummary> {
  const summary: AiPassSummary = { analyzed: 0, matched: 0, failedBatches: 0, firstError: '' }
  const knowledge = allFacts.value
  const domain = pageDomain()
  const knownFactIds = new Set(knowledge.map(fact => fact.id))
  const visited = new Set<string>()
  const adopt = (items: SlotSuggestion[]): Set<string> => {
    const ready = new Set<string>()
    for (const item of items) {
      const field = fields.value.find(candidate => candidate.id === item.fieldId)
      if (!field || results[field.id]?.status === 'filled' || field.current.trim()) continue
      const validSlot = item.slot ? slotById(item.slot) : undefined
      const validFact = item.factId ? knownFactIds.has(item.factId) : false
      if (!validSlot && !validFact) continue
      aiSuggestions[field.id] = item
      resolveOne(field)
      if (isPreviewFillable(resolutions[field.id])) ready.add(field.id)
    }
    summary.matched += ready.size
    return ready
  }

  busy.value = true
  try {
    // 身份字段经 AI 写入后可能让页面长出新字段；最多补扫一轮。
    for (let wave = 0; wave < 2; wave += 1) {
      const pending = fieldsNeedingAi(fields.value, id => resolutions[id]?.status)
        .filter(field => !visited.has(field.id) && results[field.id]?.status !== 'filled')
      if (!pending.length) break
      pending.forEach(field => visited.add(field.id))
      fillProgress.aiTotal += pending.length

      const cached = await getCachedSuggestions(domain, pending.map(field => ({ fieldId: field.id, fingerprint: field.fingerprint })), knowledge).catch(() => [] as SlotSuggestion[])
      const cachedIds = new Set(cached.map(item => item.fieldId))
      if (cached.length) {
        status.value = `AI 缓存命中 ${cached.length} 个字段，正在填写…`
        const ready = adopt(cached)
        if (ready.size) {
          try { await onBatchResolved(ready) }
          catch (error) {
            summary.failedBatches += 1
            summary.firstError ||= error instanceof Error ? error.message : '写入失败'
          }
        }
        fillProgress.aiAnalyzed += cached.length
        summary.analyzed += cached.length
      }

      const remaining = pending.filter(field => !cachedIds.has(field.id))
      if (!remaining.length) continue
      if (!aiReady.value) throw new Error('请先在档案设置中保存 API URL、API Key 和模型名称。')
      const chunks = aiFieldChunks(remaining)
      const fresh: SlotSuggestion[] = []
      let cursor = 0
      let applied = Promise.resolve()
      const worker = async (): Promise<void> => {
        while (cursor < chunks.length) {
          const chunk = chunks[cursor++]
          try {
            const suggestions = await suggestSlotMatches(chunk, aiFactsForChunk(chunk, knowledge), aiSettings.value)
            fresh.push(...suggestions)
            status.value = `AI 已返回 ${chunk.length} 个字段的分析结果，正在填写…`
            applied = applied.then(async () => {
              const ready = adopt(suggestions)
              if (ready.size) await onBatchResolved(ready)
            }).catch(error => {
              summary.failedBatches += 1
              summary.firstError ||= error instanceof Error ? error.message : '写入失败'
            }).then(() => {
              fillProgress.aiAnalyzed += chunk.length
              summary.analyzed += chunk.length
              status.value = `AI 已处理 ${fillProgress.aiAnalyzed}/${fillProgress.aiTotal} 个字段。`
            })
          } catch (error) {
            fillProgress.aiAnalyzed += chunk.length
            summary.analyzed += chunk.length
            summary.failedBatches += 1
            summary.firstError ||= error instanceof Error ? error.message : 'AI 分析失败'
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, () => worker()))
      await applied
      if (fresh.length) {
        await putCachedSuggestions(domain, knowledge, fresh.flatMap(item => {
          const field = fields.value.find(candidate => candidate.id === item.fieldId)
          return field ? [{ fingerprint: field.fingerprint, suggestion: item }] : []
        })).catch(() => undefined)
      }
    }
    // 并发批次可能先识别子选项、后识别父选项；父项写完后只补试一次受选项依赖影响的字段。
    const retry = new Set(fields.value.filter(field => aiSuggestions[field.id]
      && results[field.id]?.status === 'failed'
      && (results[field.id]?.reasonCode === 'no-matching-option'
        || results[field.id]?.reasonCode === 'option-list-not-found')).map(field => field.id))
    if (retry.size) {
      try { await onBatchResolved(retry) }
      catch (error) {
        summary.failedBatches += 1
        summary.firstError ||= error instanceof Error ? error.message : '选项补填失败'
      }
    }
    return summary
  } finally {
    busy.value = false
  }
}

/** AI 高置信不覆盖用户改过的别名；用户确认时 overwrite。同名多板块只记站点指纹。 */
function rememberFieldMapping(field: FormField, slot: string, domain: string, overwrite: boolean) {
  const shared = aliasSectionCount(field.label) >= 2
  if (field.label.trim() && (!shared || field.sectionId)) {
    learnAlias(field.label, slot, { overwrite, sectionId: shared ? field.sectionId : undefined })
      .then(result => {
        if (result === 'conflict') status.value = `「${field.label}」已经对应到别的槽位，这次没有改写。`
        return loadLearnedAliases()
      })
      .then(rows => { learnedAliasRows.value = rows })
      .catch(() => undefined)
  }
  if (overwrite && domain) dropCachedSuggestion(domain, field.fingerprint).catch(() => undefined)
  if (!domain) return
  const save = overwrite
    ? recordCorrection(domain, field.fingerprint, slot, { label: field.label, sectionId: field.sectionId })
    : recordObservation(domain, field.fingerprint, slot, 'ai')
  save.catch(() => undefined)
}

/** 用户在下拉中改选档案值：修正即学习（F25），记录（域名, 指纹, 槽位）。 */
async function selectionChanged(field: FormField) {
  const fact = allFacts.value.find(item => item.id === selections[field.id])
  if (!fact) {
    resolveOne(field)
    return
  }
  const { slot } = factToSlot(fact)
  resolutions[field.id] = {
    fieldId: field.id,
    factId: fact.id,
    value: fact.value,
    source: fact.source || 'manual',
    confidence: 1,
    reason: '用户手动确认',
    candidates: [],
    status: 'ready',
    slot: slot || field.slot
  }
  if (slot) {
    const domain = pageDomain()
    rememberFieldMapping(field, slot, domain, true)
    if (domain && slot !== field.slot) {
      status.value = `已记录该站点的字段规则（${field.label || field.fingerprint} → ${slotById(slot)?.aliases[0] || slot}），下次自动命中。`
    }
  }
}

const PROJECTABLE_CHOICE_KINDS = new Set(['select', 'multiselect', 'cascade', 'combobox'])

function fillRequests(targets: FormField[], onlyFieldId?: string): FillRequest[] {
  // 绑定分组始终以整页字段计算，保证流式分批多次调用时组内顺序一致。
  const bindings = onlyFieldId
    ? new Map()
    : planValueBindings(fields.value, field => selections[field.id] || resolutions[field.id]?.factId)
  for (const field of fields.value) {
    const binding = bindings.get(field.id)
    field.valueBinding = binding
      ? { groupId: binding.groupId, shape: binding.shape, index: binding.index, size: binding.size }
      : undefined
  }
  const eligible = onlyFieldId ? targets : targets.filter(field => {
    if (isPreviewFillable(resolutions[field.id])) return true
    const binding = bindings.get(field.id)
    if (!binding || field.current.trim() || resolutions[field.id]?.status === 'skipped') return false
    return !selections[field.id]
      || (resolutions[field.id]?.status === 'needs-confirmation'
        && resolutions[field.id]?.reasonCode === 'no-matching-option')
  })
  return eligible.flatMap(field => {
    const resolution = resolutions[field.id]
    const binding = bindings.get(field.id)
    const fact = allFacts.value.find(item => item.id === (binding?.factId || selections[field.id]))
    const value = fact?.value || resolution?.value
    if (!value || (!binding && !selections[field.id])) return []
    const factSlot = fact ? factToSlot(fact).slot : undefined
    // 选择类控件一律让写入层按真实选项投影选中最匹配项，而不是把原始值直接打进去。
    const projectable = Boolean(binding) || PROJECTABLE_CHOICE_KINDS.has(field.kind)
    return [{
      fieldId: field.id,
      value: binding ? value : resolution?.value || value,
      source: resolution?.source === 'empty' ? fact?.source : resolution?.source,
      confidence: resolution?.confidence,
      slot: resolution?.slot || factSlot,
      valueMode: projectable ? 'match-options' : 'literal',
      bindingGroupId: binding?.groupId,
      dependsOn: binding?.previousFieldId ? [binding.previousFieldId] : undefined
    }]
  })
}

function resolutionCounts(targets: FormField[], onlyFieldId?: string): { pending: number; empty: number } {
  if (onlyFieldId) return { pending: 0, empty: 0 }
  return {
    pending: targets.filter(field => {
    const resolution = resolutions[field.id]
    return resolution?.status === 'needs-confirmation' && !isPreviewFillable(resolution)
    }).length,
    empty: targets.filter(field => resolutions[field.id]?.status === 'empty').length
  }
}

function acceptFillResults(rows: FillResult[]): void {
  for (const result of rows) {
    results[result.fieldId] = result
    const field = fields.value.find(item => item.id === result.fieldId)
    if (field?.ruleId) {
      if (result.status === 'filled') recordHit(field.ruleId).catch(() => undefined)
      else if (result.reasonCode === 'no-matching-option' || result.reasonCode === 'rejected-by-validation') {
        recordFailure(field.ruleId).catch(() => undefined)
      }
    }
    if (field?.learnedAlias) {
      if (result.status === 'filled') recordAliasHit(field.learnedAlias, field.sectionId).catch(() => undefined)
      else if (result.reasonCode === 'no-matching-option' || result.reasonCode === 'rejected-by-validation') {
        recordAliasFailure(field.learnedAlias, field.sectionId).catch(() => undefined)
      }
    }
    if (result.status !== 'filled' || !field) continue
    const slot = resolutions[field.id]?.slot || field.slot
    const suggestion = aiSuggestions[field.id]
    const viaAi = resolutions[field.id]?.source === 'ai'
      && suggestion
      && suggestion.confidence * 100 >= featureSettings.aiMatchThreshold
    if (viaAi && slot) rememberFieldMapping(field, slot, pageDomain(), false)
    else {
      const signals = field.slotCandidates?.[0]?.signals || {}
      const inferred = signals.labelMatch !== 1 && !signals.learnedAlias && !signals.siteRule && !field.ruleId
      const domain = pageDomain()
      if (inferred && slot && domain) recordObservation(domain, field.fingerprint, slot, 'fill').catch(() => undefined)
    }
  }
}

async function sendFillRequests(values: FillRequest[], resetUndo: boolean): Promise<FillResult[]> {
  if (!values.length) return []
  const response = await requestContent({ type: 'FILL', values, resetUndo, runId: activeFillRunId || undefined })
  if (response.error) throw new Error(response.error)
  const rows = response.results as FillResult[]
  acceptFillResults(rows)
  if (activeFillRunId) rows.forEach(updateFillProgress)
  return rows
}

async function fill(onlyFieldId?: string, options?: { armKnowledgeWatch?: boolean }) {
  let targets = onlyFieldId ? fields.value.filter(field => field.id === onlyFieldId) : fields.value
  let counts = resolutionCounts(targets, onlyFieldId)
  let values = fillRequests(targets, onlyFieldId)
  if (!values.length) {
    if (options?.armKnowledgeWatch) {
      knowledgeWatch.value = true
      learned.value = []
    }
    const watchNote = options?.armKnowledgeWatch ? '正在监测你之后在网页上的修改。' : ''
    status.value = counts.pending
      ? `${counts.pending} 个字段仍待确认（候选冲突或选项需核对），请先在下拉中逐项确认。${watchNote}`
      : `请先为至少一个字段选择档案信息。${watchNote}`
    return
  }
  busy.value = true
  try {
    let rows: FillResult[] = []
    const phases = splitIdentityFillRequests(values, fields.value)
    if (!onlyFieldId && phases.identity.length && phases.remaining.length) {
      status.value = `正在先填写 ${phases.identity.length} 个记录身份字段…`
      const identityRows = await sendFillRequests(phases.identity, true)
      rows.push(...identityRows)

      status.value = '身份字段已填写，正在等待页面更新并重新识别…'
      const again = await requestContent({ type: 'SCAN', probeOptions: false })
      if (again.error) throw new Error(again.error)
      applyScan(again)
      for (const result of identityRows) {
        if (fields.value.some(field => field.id === result.fieldId)) results[result.fieldId] = result
      }
      busy.value = true
      targets = fields.value
      counts = resolutionCounts(targets)
      values = fillRequests(targets)
      status.value = `页面已更新，正在填写其余 ${values.length} 个字段…`
      rows.push(...await sendFillRequests(values, false))
    } else {
      rows = await sendFillRequests(values, true)
    }
    const summaryRows = [...new Map(rows.map(result => [result.fieldId, result])).values()]
    const filled = summaryRows.filter(result => result.status === 'filled').length
    const kept = summaryRows.filter(result => result.status === 'skipped').length
    const failed = summaryRows.filter(result => result.status === 'failed').length
    if (options?.armKnowledgeWatch) {
      knowledgeWatch.value = true
      learned.value = []
    }
    const watchNote = options?.armKnowledgeWatch ? '填写已完成，正在监测你之后在网页上的修改。' : ''
    status.value = `已填写 ${filled} 项，原值保留 ${kept} 项，失败 ${failed} 项${counts.pending ? `；${counts.pending} 个字段仍无法填写` : ''}${counts.empty ? `；${counts.empty} 个字段知识库无数据` : ''}。${watchNote}低置信匹配已用橙色标记。`
  } catch (error) { status.value = error instanceof Error ? error.message : '填写失败。' }
  finally { busy.value = false }
}

function onLearnedScroll(): void {
  if (suppressLearnedScroll) return
  const list = learnedListEl.value
  if (!list) return
  learnedPinned = list.scrollHeight - list.scrollTop - list.clientHeight <= 28
}

/** 新增一行后，只有列表本来就在底部才跟着滚。不滚动外层面板。 */
function revealLatestLearned(force = false): void {
  nextTick(() => {
    requestAnimationFrame(() => {
      const list = learnedListEl.value
      if (!list || (!force && !learnedPinned)) return
      suppressLearnedScroll = true
      list.scrollTop = list.scrollHeight
      requestAnimationFrame(() => { suppressLearnedScroll = false })
    })
  })
}

/**
 * 把网页上的一个字段值整理成知识库候选，先放进待确认列表，不直接写入。
 * 插件刚写入且用户没改、或知识库里已是同一个值时，不列入待确认。
 * 页面上把内容删掉后，对应的待确认项一并去掉。
 * quiet 用于识别时吸收页面上已经填好的内容，不打断当前状态文案。
 */
function learnedValue(field: FormField, raw: string): string {
  const now = plainChoiceText(raw)
  if (!now || looksLikeFieldPrompt(now)) return ''
  if (field.placeholder && now === field.placeholder.trim()) return ''
  if (field.label && now === field.label.trim()) return ''
  const taken = fields.value.some(other => other.id !== field.id && (
    (other.label && now === other.label.trim()) || (other.placeholder && now === other.placeholder.trim())
  ))
  return taken ? '' : now
}

function noteObservedValue(
  field: FormField,
  raw: string,
  quiet = false,
  observedBindings?: Map<string, number | null>,
  previousCurrent = field.current
): void {
  const now = learnedValue(field, raw)
  const learnedAt = () => learned.value.findIndex(row => row.fieldId === field.id)
  const drop = () => {
    const index = learnedAt()
    if (index >= 0) learned.value.splice(index, 1)
  }
  if (field.attrs?.type === 'password') return
  if (now && learnedAt() < 0 && isLearnedDismissed(dismissedLearned, field.id, now)) return
  if (!now) {
    // 单选没有“清空”。回读短暂为空时不能把刚记下的选项删掉。
    if (field.kind === 'radio') return
    if (learnedAt() >= 0) {
      drop()
      field.current = ''
      if (!quiet) status.value = `已去掉「${field.label || '该字段'}」的待确认内容。`
    }
    const cleared = namedAlignInput(field, { id: field.id, value: '' })
    if (cleared) realignNamedLearned(field, alignNamedItem(cleared))
    return
  }
  if (isRelationField(field) && relationKey(now)) {
    field.current = now
    for (const peer of familyPeers(field)) {
      if (peer.id !== field.id && !peer.current.trim()) resolveOne(peer)
    }
  }
  const written = results[field.id]?.status === 'filled' ? (results[field.id].value || '').trim() : ''
  const changedOnPage = previousCurrent.trim() !== now
  const comparisonSlot = field.slot || resolutions[field.id]?.slot
  const semanticContext = { slot: comparisonSlot ? slotById(comparisonSlot) : undefined, field }
  if (written && semanticValuesMatch(written, now, semanticContext)) {
    drop()
    if (!observedBindings) {
      const named = namedAlignInput(field, { id: field.id, value: now })
      if (named) realignNamedLearned(field, alignNamedItem(named))
    }
    if (!quiet && changedOnPage) status.value = `「${field.label || '该字段'}」仍是已填写的内容，无需更新。`
    return
  }
  const slot = field.slot || resolutions[field.id]?.slot
  const sourceField = slot && slot !== field.slot ? { ...field, slot } : field
  const entry = classifyPageInput(sourceField, now, learnedAliasRows.value)
  if (!entry) return
  if (observedBindings?.has(field.id)) {
    const bound = observedBindings.get(field.id)
    if (bound === null || bound === undefined) {
      drop()
      field.current = now
      return
    }
    entry.fact.item = bound
  } else if (isFamilyField(sourceField)) {
    const relation = segmentRelation(sourceField, { id: field.id, value: now }) || (isRelationField(sourceField) ? relationKey(now) : '')
    entry.fact.item = alignFamilyItem(entry.fact.item, relation, allFacts.value)
  }
  if (!observedBindings) {
    const named = namedAlignInput(sourceField, { id: field.id, value: now })
    if (named) {
      entry.fact.item = alignNamedItem(named)
      realignNamedLearned(sourceField, entry.fact.item)
    }
  }
  const existing = allFacts.value.find(fact => knowledgeIdentity(fact) === knowledgeIdentity(entry.fact))
  const relation = existing ? compareSemanticValues(existing.value, now, {
    slot: entry.slot ? slotById(entry.slot) : undefined,
    field: sourceField
  }) : 'different'
  if (existing && (relation === 'equal' || relation === 'compatible')) {
    drop()
    if (!quiet && changedOnPage) status.value = `「${entry.fact.key}」与知识库一致，无需更新。`
    return
  }
  const origin = written ? 'correction' as const : 'supplement' as const
  const index = learnedAt()
  const current = index >= 0 ? learned.value[index] : undefined
  if (current?.pageValue === now && current.fact.item === entry.fact.item) return
  const keepTyped = Boolean(current && current.pageValue && current.fact.value !== current.pageValue)
  const row = {
    ...entry,
    fieldId: field.id,
    selected: current?.selected ?? true,
    origin,
    previous: existing?.value || '',
    pageValue: now,
    fact: { ...entry.fact, id: current?.fact.id || entry.fact.id, value: keepTyped && current ? current.fact.value : now }
  }
  field.current = now
  if (index >= 0) learned.value[index] = row
  else {
    learned.value.push(row)
    if (!revealedLearned.has(field.id)) {
      revealedLearned.add(field.id)
      revealLatestLearned()
    }
  }
  if (!quiet) status.value = `已记录「${entry.fact.key}」→ ${now.slice(0, 24)}。请确认后再更新知识库。`
}

/**
 * 监测必须以同一时刻的整页值为输入：先更新所有段锚点，再一次性绑定记录，最后逐字段比较。
 */
function processObservedSnapshot(valueMap: Map<string, string>, quiet: boolean): void {
  const previous = new Map(fields.value.map(field => [field.id, field.current]))
  for (const field of fields.value) {
    const now = learnedValue(field, valueMap.get(field.id) || '')
    if (now || field.kind !== 'radio') field.current = now
  }
  const effectiveFields = fields.value.map(field => {
    const slot = field.slot || resolutions[field.id]?.slot
    return slot && slot !== field.slot ? { ...field, slot } : field
  })
  const bindings = bindObservedRepeatRecords(effectiveFields, allFacts.value)
  unresolvedObservedCount.value = effectiveFields.filter(field => bindings.has(field.id)
    && bindings.get(field.id) === null
    && Boolean(learnedValue(field, valueMap.get(field.id) || ''))).length
  const handled = new Set<string>()
  const valueGroups = new Map<string, FormField[]>()
  for (const field of fields.value) {
    const binding = field.valueBinding
    if (!binding || binding.shape !== 'sequence') continue
    const rows = valueGroups.get(binding.groupId) || []
    rows.push(field)
    valueGroups.set(binding.groupId, rows)
  }
  for (const rows of valueGroups.values()) {
    rows.sort((left, right) => (left.valueBinding?.index || 0) - (right.valueBinding?.index || 0))
    rows.forEach(field => handled.add(field.id))
    const currentParts = rows.map(field => learnedValue(field, valueMap.get(field.id) || ''))
    // 任一成员尚未回读到值时，整组都视为 partial，禁止把局部页面值写回知识库。
    if (currentParts.some(part => !part)) continue
    const previousParts = rows.map(field => previous.get(field.id) || '').filter(Boolean)
    const representative = rows.find(field => field.slot || resolutions[field.id]?.slot) || rows[0]
    const memberIds = new Set(rows.filter(field => field.id !== representative.id).map(field => field.id))
    learned.value = learned.value.filter(row => !memberIds.has(row.fieldId))
    noteObservedValue(
      representative,
      currentParts.join(' / '),
      quiet,
      bindings,
      previousParts.join(' / ')
    )
  }
  for (const field of fields.value) {
    if (handled.has(field.id)) continue
    noteObservedValue(field, valueMap.get(field.id) || '', quiet, bindings, previous.get(field.id) || '')
  }
}

let learnedWatchTimer = 0
let learnedWatchBusy = false
let learnedWatchSeen = false

function stopLearnedWatch(): void {
  window.clearInterval(learnedWatchTimer)
  learnedWatchTimer = 0
  learnedWatchSeen = false
}

/** 填写完成后自己读页面。点击监测经常到不了面板，和「重新读取」走同一条回读。 */
async function pollLearned(): Promise<void> {
  if (!knowledgeWatch.value || learnedWatchBusy || document.hidden) return
  learnedWatchBusy = true
  const known = new Set(learned.value.map(row => row.fieldId))
  const previousUnresolved = unresolvedObservedCount.value
  try {
    const response = await requestContent({ type: 'READ_VALUES' })
    if (response.error || !knowledgeWatch.value) return
    const valueMap = new Map<string, string>((response.values || []).map((row: { fieldId: string; value: string }) => [row.fieldId, row.value]))
    processObservedSnapshot(valueMap, true)
    const added = learned.value.filter(row => !known.has(row.fieldId))
    if (learnedWatchSeen && added.length) {
      status.value = added.length === 1
        ? `已记录「${added[0].fact.key}」→ ${added[0].fact.value.slice(0, 24)}。请确认后再更新知识库。`
        : `监测到 ${added.length} 项修改，已列在下方。请确认后再更新知识库。`
    } else if (learnedWatchSeen && unresolvedObservedCount.value > 0 && unresolvedObservedCount.value !== previousUnresolved) {
      status.value = `${unresolvedObservedCount.value} 个字段无法唯一确定所属段，已停止自动更新这些字段，请先补充该段的名称或其他身份信息。`
    }
    learnedWatchSeen = true
  } catch { /* 下一轮再读 */ }
  finally { learnedWatchBusy = false }
}

watch(knowledgeWatch, armed => {
  stopLearnedWatch()
  if (!armed) return
  learnedPinned = true
  revealedLearned.clear()
  void pollLearned()
  learnedWatchTimer = window.setInterval(() => { void pollLearned() }, 700)
})

/** 手动再读一遍页面，补上自动观察可能漏掉的字段。仅在自动填写完成后可用。 */
async function collectLearned() {
  if (!knowledgeWatch.value) { status.value = '请先点击「自动填写」，等本页填充完成后再核对知识库。'; return }
  if (!fields.value.length) { status.value = '请先识别页面。'; return }
  busy.value = true
  try {
    const response = await requestContent({ type: 'READ_VALUES' })
    if (response.error) throw new Error(response.error)
    dismissedLearned.clear()
    const valueMap = new Map<string, string>((response.values || []).map((row: { fieldId: string; value: string }) => [row.fieldId, row.value]))
    processObservedSnapshot(valueMap, true)
    if (learned.value.length) revealLatestLearned()
    const corrections = learned.value.filter(entry => entry.origin === 'correction').length
    const unresolved = unresolvedObservedCount.value
    status.value = learned.value.length
      ? `发现 ${learned.value.length - corrections} 条补充、${corrections} 条修正${unresolved ? `；另有 ${unresolved} 个字段无法唯一确定所属段，已阻止更新` : ''}。请在下方核对并编辑，确认无误后再更新知识库。`
      : unresolved
        ? `${unresolved} 个字段无法唯一确定所属段，已停止自动更新这些字段，请先补充该段的名称或其他身份信息。`
        : '没有发现需要学习的内容：页面值与插件填写和知识库一致。'
  } catch (error) { status.value = error instanceof Error ? error.message : '读取页面输入失败。' }
  finally { busy.value = false }
}

async function saveLearned() {
  const chosen = learned.value.filter(entry => entry.selected && entry.fact.value.trim())
  if (!chosen.length) { status.value = '请先勾选要保存的条目。'; return }
  const summary = chosen.map(entry => {
    const item = Math.max(1, entry.fact.item || 1)
    return `「${entry.fact.group} · 第 ${item} 段 · ${entry.fact.key}」→ ${entry.fact.value.slice(0, 20)}`
  }).slice(0, 6).join('、')
  if (!confirm(`确认更新知识库 ${chosen.length} 条？\n${summary}${chosen.length > 6 ? ' 等' : ''}\n同一板块、同一段里的同名字段会被更新。`)) return
  const merged = mergeIntoKnowledge(facts.value, chosen.map(entry => ({ ...entry.fact, value: entry.fact.value.trim() })))
  await saveProfile(merged.facts)
  facts.value = tagFacts((await loadProfile()).facts, 'profile')
  const domain = pageDomain()
  for (const entry of chosen) {
    const field = fields.value.find(item => item.id === entry.fieldId)
    if (entry.slot && entry.fieldLabel.trim() && (aliasSectionCount(entry.fieldLabel) < 2 || entry.fact.group)) {
      const sectionId = aliasSectionCount(entry.fieldLabel) >= 2 ? field?.sectionId : undefined
      if (aliasSectionCount(entry.fieldLabel) < 2 || sectionId) {
        await learnAlias(entry.fieldLabel, entry.slot, { overwrite: true, sectionId }).catch(() => undefined)
      }
    }
    if (domain && field?.fingerprint && entry.slot) {
      await recordCorrection(domain, field.fingerprint, entry.slot, { label: entry.fieldLabel, sectionId: field.sectionId }).catch(() => undefined)
      await dropCachedSuggestion(domain, field.fingerprint).catch(() => undefined)
    }
  }
  learnedAliasRows.value = await loadLearnedAliases()
  rememberDismissedLearned(learned.value.filter(entry => !entry.selected || !entry.fact.value.trim()))
  learned.value = []
  status.value = `知识库已更新：新增 ${merged.added} 条、更新 ${merged.updated} 条。下次遇到相同字段会自动匹配。`
}

function rememberDismissedLearned(rows: Array<{ fieldId: string; pageValue?: string; fact: { value: string } }>): void {
  for (const row of rows) {
    const pageValue = (row.pageValue ?? row.fact.value).trim()
    if (row.fieldId && pageValue) dismissedLearned.add(learnedDismissKey(row.fieldId, pageValue))
  }
}

function abandonLearned(): void {
  rememberDismissedLearned(learned.value)
  learned.value = []
  status.value = '已放弃这些待确认内容。页面上的这些值不会再次列入，直到你改成新的内容。'
}

async function copyValue(value: string): Promise<boolean> {
  try {
    if (!featureSettings.autoClipboard) return false
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(value)
    return true
  } catch { return false }
}

async function assistFill(fact: Fact, fieldId: string, source?: FillRequest['source'], confidence = 1) {
  try {
    const copied = await copyValue(fact.value)
    const response = await requestContent({ type: 'MANUAL_FILL', fieldId, value: fact.value, source: source || fact.source || 'manual', confidence, copied })
    if (response.status === 'picker') {
      pickerActive.value = true
      status.value = `${copied ? '已复制内容，' : ''}请点击网页中的目标输入框。`
      return
    }
    const result = response.result as FillResult | undefined
    if (result && fields.value.some(field => field.id === result.fieldId)) results[result.fieldId] = result
    status.value = result?.status === 'filled'
      ? `已填写“${fact.value.slice(0, 24)}”${copied ? '，并复制到剪贴板' : ''}。`
      : result?.message || '手动辅助填写失败。'
  } catch (error) { status.value = error instanceof Error ? error.message : '手动辅助填写失败。' }
}

async function manualFill(field: FormField) {
  const fact = allFacts.value.find(item => item.id === selections[field.id])
  if (!fact) { status.value = '请先为该字段选择一个值。'; return }
  const resolvedSource = resolutions[field.id]?.source
  await assistFill(fact, field.id, resolvedSource && resolvedSource !== 'empty' ? resolvedSource : fact.source, resolutions[field.id]?.confidence || 1)
}

async function manualFillFact(fact: Fact) {
  await assistFill(fact, `manual-${fact.id}`, fact.source || 'manual', fact.confidence || 1)
}

async function cancelPicker() {
  await requestContent({ type: 'CANCEL_PICKER' })
  pickerActive.value = false
  status.value = '已取消选择网页输入框。'
}

async function confirmAiField(fieldId: string) {
  const response = await requestContent({ type: 'CONFIRM_FIELD', fieldId })
  if (response?.status === 'confirmed') {
    if (results[fieldId]) results[fieldId] = { ...results[fieldId], source: 'manual', needsReview: false }
    const field = fields.value.find(item => item.id === fieldId)
    const slot = resolutions[fieldId]?.slot || field?.slot
    if (field && slot) rememberFieldMapping(field, slot, pageDomain(), true)
    status.value = '该 AI 匹配结果已确认，字段已恢复正常高亮，并记为本站规则。'
  } else {
    status.value = '网页字段已变化，请重新识别后再确认。'
  }
}

async function undo() {
  try {
    const response = await requestContent({ type: 'UNDO' })
    const rows = (response.results || []) as FillResult[]
    const failed = rows.filter(result => result.status === 'failed')
    status.value = failed.length
      ? `已恢复可撤销字段；${failed.length} 个控件无法自动恢复：${failed.map(row => row.message).join('；')}`
      : '已恢复本次填写前的值。'
  } catch (error) { status.value = error instanceof Error ? error.message : '撤销失败。' }
}

async function polish() {
  const field = selectedField.value
  if (!field) return
  const original = field.current || allFacts.value.find(fact => fact.id === selections[field.id])?.value || ''
  if (!original.trim()) { status.value = '请先为该字段准备原文。'; return }
  busy.value = true
  status.value = '正在生成润色建议…'
  try {
    const selectedFact = allFacts.value.find(fact => fact.id === selections[field.id])
    const relevantFacts = selectedFact
      ? allFacts.value.filter(fact => (fact.group === selectedFact.group && fact.item === selectedFact.item) || /技能|证书/.test(fact.group))
      : allFacts.value.filter(fact => /工作|项目|技能|证书|开放文本/.test(fact.group)).slice(0, 40)
    aiSettings.value = await loadAiSettings()
    if (!aiReady.value) throw new Error('请先在档案设置中保存 AI 配置。')
    suggestion.value = await polishText(original, jobDescription.value, maxLength.value, relevantFacts, aiSettings.value)
    polished.value = true
    status.value = '请检查建议是否与真实经历一致；确认后再采用。'
  } catch (error) { status.value = error instanceof Error ? error.message : '润色失败。' }
  finally { busy.value = false }
}

async function adopt() {
  if (!selectedPolishField.value || !suggestion.value.trim()) return
  try {
    const response = await requestContent({ type: 'FILL', values: [{ fieldId: selectedPolishField.value, value: suggestion.value.trim(), intent: 'manual' }] })
    const result = (response.results as FillResult[])[0]
    if (result) results[result.fieldId] = result
    status.value = result?.status === 'filled' ? '建议已写入网页，请在提交前核对。' : result?.message || '写入失败。'
  } catch (error) { status.value = error instanceof Error ? error.message : '写入失败。' }
}

function sourceLabel(source?: string): string {
  return source === 'profile' ? '我的信息' : source === 'resume' ? '当前简历' : source === 'ai' ? 'AI 推断' : '手动选择'
}

function factLabel(fact: Fact) { return `${sourceLabel(fact.source)} · ${fact.group}${fact.item > 1 ? ` ${fact.item}` : ''} · ${fact.key}：${fact.value.slice(0, 35)}` }

/** 字段状态徽标：与上方标签同一套状态，并带上匹配置信度。 */
function fieldStateChip(field: FormField): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  const bucket = fieldReviewBucket(field)
  const confidence = resolutions[field.id]?.confidence
  const percent = confidence ? ` ${Math.round(confidence * 100)}%` : ''
  if (bucket === 'pending') return { text: `未填写${percent}`, tone: 'warn' }
  if (bucket === 'confirmed') return { text: `已匹配${percent}`, tone: 'ok' }
  if (bucket === 'filled') return fieldNeedsAttention(field)
    ? { text: `已填写·请留意${percent}`, tone: 'warn' }
    : { text: `已填写${percent}`, tone: 'ok' }
  if (bucket === 'failed') return { text: '填写失败', tone: 'warn' }
  if (bucket === 'kept') return { text: '原值保留', tone: 'muted' }
  if (field.slotStatus === 'ambiguous') return { text: '语义模糊', tone: 'warn' }
  return { text: '无数据', tone: 'muted' }
}

function matchSummary(fieldId: string): string {
  const resolution = resolutions[fieldId]
  if (!resolution) return ''
  const fact = allFacts.value.find(item => item.id === selections[fieldId])
  const source = sourceLabel(resolution.source === 'empty' ? fact?.source : resolution.source)
  const slotName = resolution.slot ? slotById(resolution.slot)?.aliases[0] : ''
  const confidence = resolution.confidence ? ` · 置信度 ${Math.round(resolution.confidence * 100)}%` : ''
  const parts = [resolution.status === 'empty' || resolution.status === 'skipped' ? '' : source, slotName ? `槽位「${slotName}」` : '', resolution.reason]
  return `${parts.filter(Boolean).join(' · ')}${confidence}`
}

function resultTone(result?: FillResult): string {
  if (!result) return ''
  if (result.status === 'failed') return 'error-text'
  if (result.status === 'skipped') return 'warning-text'
  return 'success-text'
}

function resultDetail(result: FillResult): string {
  const parts = [result.message]
  if (result.reasonCode && result.reasonCode !== 'ok') parts.push(`原因码：${result.reasonCode}`)
  if (result.attempts && result.attempts > 1) parts.push(`重试 ${result.attempts - 1} 次`)
  if (result.trace?.length) {
    const stageNames: Record<string, string> = { locate: '定位', precheck: '预检', apply: '写入', settle: '等待', verify: '验证', visual: '视觉' }
    parts.push(`轨迹：${result.trace.slice(-8).map(step => `${stageNames[step.stage] || step.stage}${step.status === 'ok' ? '✓' : step.status === 'retry' ? '↻' : step.status === 'skipped' ? '－' : '×'}`).join('→')}`)
  }
  return parts.join(' · ')
}

function diagnosticDetail(field: FormField): string {
  const stageNames: Record<string, string> = {
    discovery: '发现', classification: '分类', 'semantic-match': '语义',
    'fact-join': '数据', 'value-gate': '闸门', interaction: '交互', verification: '验证', visual: '视觉'
  }
  const reasonNames: Record<string, string> = {
    'unlabeled-control': '缺少标签', 'unknown-control-type': '类型未知', 'unknown-slot': '语义未知',
    'ambiguous-slot': '语义歧义', 'no-profile-data': '知识库无数据', 'multiple-profile-candidates': '多个档案候选',
    'blocked-by-complete-option-set': '完整选项无匹配', 'partial-option-set-search-required': '需展开搜索',
    'multiple-option-candidates': '选项歧义', 'value-validation-rejected': '值校验拒绝', 'value-truncated': '内容已截断',
    'popup-not-found': '浮层未找到', 'remote-options-timeout': '远程选项超时', 'trusted-input-failed': '可信输入失败',
    'readback-mismatch': '回读不一致', 'validation-rejected': '页面校验拒绝', 'visual-not-eligible': '不适用视觉',
    'visual-not-configured': '视觉未配置', 'visual-consensus-failed': '视觉未达成一致', 'restricted-frame': '受限页面区域'
  }
  const statusMarks: Record<string, string> = { passed: '✓', warning: '△', blocked: '×', skipped: '－' }
  return fullFieldDiagnostics(field, resolutions[field.id], results[field.id])
    .map(item => {
      const detail = item.reason ? reasonNames[item.reason] || item.reason : item.strategy?.startsWith('trusted:') ? '可信输入' : ''
      return `${stageNames[item.stage] || item.stage}${statusMarks[item.status] || ''}${detail ? `(${detail})` : ''}`
    })
    .join('→')
}

async function exportDiagnostics(): Promise<void> {
  const quality = await loadQualityMetrics().catch(() => [])
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    summary: diagnosticFunnel.value,
    quality,
    regressionFixture: buildRegressionFixture(pageDomain(), fields.value, resolutions, results),
    fields: fields.value.map((field, index) => ({
      index: index + 1,
      kind: field.kind,
      frame: field.frameId ?? 0,
      required: field.required,
      optionCoverage: field.optionCoverage,
      slotStatus: field.slotStatus,
      resolutionStatus: resolutions[field.id]?.status,
      resultStatus: results[field.id]?.status,
      reasonCode: results[field.id]?.reasonCode || resolutions[field.id]?.reasonCode,
      attempts: results[field.id]?.attempts,
      elapsedMs: results[field.id]?.elapsedMs,
      diagnostics: fullFieldDiagnostics(field, resolutions[field.id], results[field.id]).map(item => ({
        stage: item.stage,
        status: item.status,
        reason: item.reason,
        strategy: item.strategy,
        optionCoverage: item.optionCoverage
      }))
    }))
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `resume-autofill-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
</script>

<template>
  <main v-if="!licenseChecked || !license" class="activation-shell">
    <section class="activation-card">
      <header class="activation-hero draggable-header" @pointerdown="dragFromHeader">
        <div class="activation-brand">
          <img src="/assets/ui/brand-cover.png" alt="鸿途网申助手品牌图" />
          <div><h1>鸿途网申助手</h1><p>让求职申请更简单</p></div>
        </div>
        <img class="activation-mascot" src="/assets/ui/activation-mascot.png" alt="简历助手吉祥物" />
        <button class="activation-close" type="button" title="关闭" aria-label="关闭授权窗口" @click="closePanel">×</button>
      </header>

      <div v-if="!licenseChecked" class="activation-loading" role="status"><span></span>正在检查授权…</div>
      <template v-else>
        <div class="activation-body">
          <div class="activation-info"><span>i</span><p>输入激活码后才能使用填写、简历识别和 AI 功能。</p></div>

          <aside class="activation-notice" aria-labelledby="activation-notice-title">
            <div class="notice-icon">✦</div>
            <div>
              <h2 id="activation-notice-title">【插件公告】</h2>
              <p>插件激活码可加 QQ 群免费获取：<strong>372728248</strong>。</p>
              <p>本插件仅提供免费使用，不收取任何费用。所有数据均存储在浏览器本地，不会上传服务器，安全放心。</p>
              <p>AI 相关服务需要您自行接入 OpenAI 格式的接口（自行填写 API Key、Base URL、模型等信息），请确保接口兼容 OpenAI 格式。</p>
              <p>如需激活码或使用交流，欢迎加群：<strong>372728248</strong>。请勿相信任何付费售卖激活码的行为，感谢支持！</p>
            </div>
          </aside>

          <form class="activation-form" @submit.prevent="submitActivation">
            <label for="activation-code">激活插件</label>
            <div class="activation-input-wrap">
              <input id="activation-code" v-model="activationCode" type="text" placeholder="请输入激活码" spellcheck="false" autocomplete="off" @input="activationError = ''" />
              <span class="clipboard-icon" aria-hidden="true">▣</span>
            </div>
            <p v-if="activationError" class="activation-error" role="alert"><span>!</span>{{ activationError }}</p>
            <div class="activation-actions">
              <button class="activation-cancel" type="button" @click="closePanel">取消</button>
              <button class="activation-submit" type="submit" :disabled="activating || !activationCode.trim()">{{ activating ? '正在激活…' : '激活' }}</button>
            </div>
          </form>
        </div>
      </template>
    </section>
  </main>
  <template v-else>
  <main v-if="!showingControl" class="popup flex h-full min-h-0 w-full flex-col overflow-hidden bg-gradient-to-b from-white to-[#f5f9ff] p-[13px] text-brand-navy" :class="{ expanded, 'compact-mode': !expanded }">
    <header class="panel-brand draggable-header relative z-20 shrink-0 flex items-center gap-2 pb-[11px]" :class="{ 'compact-brand': !expanded }" @pointerdown="dragFromHeader">
      <span class="header-drag-handle" title="按住拖动面板" aria-hidden="true"></span>
      <div v-if="!expanded" class="compact-brand-icon"><img src="/assets/ui/brand-cover.png" alt="鸿途网申助手品牌图" /></div>
      <img v-else class="size-11 rounded-[11px] object-cover" src="/assets/ui/brand-cover.png" alt="鸿途网申助手品牌图" />
      <div class="compact-brand-copy min-w-0 flex-1"><h1 class="m-0 text-[17px]">鸿途网申助手</h1><p class="mt-0.5 mb-0 text-[9px] text-brand-muted">让求职申请更简单</p></div>
      <img v-if="!expanded" class="compact-hero-mascot" src="/assets/ui/compact-mascot.png" alt="" aria-hidden="true" />
      <button v-if="!expanded" class="compact-top-close" title="关闭" aria-label="关闭面板" @click="closePanel">×</button>
      <button v-else class="panel-close" title="缩小面板" aria-label="缩小面板" @click="openCompactView">−</button>
    </header>

    <template v-if="!expanded">
      <div class="compact-content">
        <div :class="['ready-card', fields.length ? 'online' : '', { loading: autoFillRunning }]"><span><i v-if="autoFillRunning" class="auto-fill-spinner"></i><template v-else>{{ fields.length ? '✓' : '…' }}</template></span><div><b>{{ autoFillRunning ? '正在自动填写' : busy ? '正在识别' : fields.length ? '已就绪' : '等待表单' }}</b><small>{{ autoFillRunning ? status : pageContext?.pageTitle || '请打开可填写的网申页面' }}</small></div><i>›</i></div>
        <button class="panel-auto" :disabled="busy || autoFillRunning" @click="autoFill"><span><i v-if="autoFillRunning" class="auto-fill-spinner"></i><template v-else>▶</template></span><b>{{ autoFillRunning ? '正在自动填写…' : busy ? '正在处理…' : '自动填写' }}</b><i>✦</i></button>
        <button class="panel-assist" @click="openFillView"><span>✓</span><b>核对匹配</b><i>›</i></button>
        <section class="panel-section knowledge-home">
          <div class="panel-section-title">
            <span class="knowledge-icon">▤</span>
            <div><h2>核对并更新知识库</h2><small>{{ knowledgeWatch ? '正在监测填写完成后的修改' : '等待自动填写完成' }}</small></div>
            <button :disabled="busy || !knowledgeWatch" @click="collectLearned"><span>↻</span>重新读取</button>
          </div>
          <p v-if="!knowledgeWatch" class="knowledge-hint">请先点击「自动填写」。本页填充完成后，这里才会开始记录你在网页上的补充和修改。</p>
          <p v-else-if="!learned.length" class="knowledge-empty">正在监测。你在网页上补充或改过字段后，会列在这里，确认后才写入知识库。清空网页上的内容会去掉对应的待确认项。</p>
          <template v-else>
            <div ref="learnedListEl" class="learned-list" @scroll="onLearnedScroll">
              <div v-for="entry in learned" :key="entry.fact.id" class="learned-row">
                <input v-model="entry.selected" type="checkbox" :aria-label="`更新 ${entry.fact.key}`" />
                <div class="learned-body">
                  <span class="learned-meta">{{ entry.fact.group }}<template v-if="entry.fact.item > 1"> · 第 {{ entry.fact.item }} 段</template> · {{ entry.fact.key }}<em v-if="entry.custom">（自定义字段）</em><b :class="entry.origin">{{ entry.origin === 'correction' ? '修正' : '补充' }}</b></span>
                  <small v-if="entry.fieldLabel.trim() && entry.fieldLabel.trim() !== entry.fact.key" class="learned-previous">网页字段：{{ entry.fieldLabel }}</small>
                  <small v-if="entry.previous" class="learned-previous">知识库原值：{{ entry.previous.slice(0, 40) }}</small>
                  <input v-model="entry.fact.value" type="text" :aria-label="`${entry.fact.key} 的值`" />
                </div>
              </div>
            </div>
            <div class="panel-action-row"><button class="panel-primary" :disabled="busy" @click="saveLearned">确认并更新知识库</button><button @click="abandonLearned">放弃</button></div>
          </template>
        </section>
        <p :class="['panel-status', { loading: autoFillRunning }]" role="status"><span v-if="autoFillRunning" class="inline-loading"></span>{{ status }}</p>
        <p class="visual-health-line"><span :class="{ ready: visualHealth.ocrAvailable }">●</span>{{ visualHealthText }} <button :disabled="visualHealth.checking" @click="refreshVisualHealth">刷新</button></p>
      </div>
      <footer class="panel-footer shrink-0"><button @click="openControl('settings')"><span>⚙</span>设置</button><button @click="openControl('home')"><span>⛶</span>展开</button><button @click="closePanel"><span>×</span>关闭</button></footer>
    </template>

    <div v-else class="panel-body">
      <div class="panel-toolbar"><button @click="openCompactView">‹ 返回缩小态</button><span>核对匹配</span><button @click="scan()">↻ 重新识别</button></div>
      <div class="panel-metrics"><div><b>{{ fields.length }}</b><small>识别字段</small></div><div><b>{{ matchedCount }}</b><small>成功匹配</small></div><div><b>{{ report.filled.length }}</b><small>已填写</small></div><div><b>{{ report.failed.length }}</b><small>失败</small></div></div>
      <div class="diagnostic-funnel" aria-label="字段处理漏斗">
        <span>发现 {{ diagnosticFunnel.discovered }}</span><i>→</i><span>分类 {{ diagnosticFunnel.classified }}</span><i>→</i><span>语义 {{ diagnosticFunnel.semanticMatched }}</span><i>→</i><span>闸门 {{ diagnosticFunnel.gatePassed }}</span><i>→</i><span>交互 {{ diagnosticFunnel.interactionStarted }}</span><i>→</i><span>验证 {{ diagnosticFunnel.verified }}</span>
        <button :disabled="!fields.length" title="包含脱敏字段轨迹、质量指标和回归夹具" @click="exportDiagnostics">导出诊断/质量</button>
      </div>
      <p class="visual-health-line"><span :class="{ ready: visualHealth.ocrAvailable }">●</span>{{ visualHealthText }} <button :disabled="visualHealth.checking" @click="refreshVisualHealth">刷新</button></p>
      <p v-if="newFieldsHint" class="picker-notice">页面出现 {{ newFieldsHint }} 个新字段。<button @click="scan()">重新识别</button></p>
      <p v-if="pickerActive" class="picker-notice">请点击网页中的目标输入框。<button @click="cancelPicker">取消</button></p>
      <p class="panel-status" role="status">{{ status }}</p>
      <div class="panel-action-row"><button class="panel-primary" :disabled="busy || autoFillRunning" @click="autoFill">两轮自动填写</button><button @click="undo">撤销</button></div>

      <section v-if="report.filled.length || report.kept.length || report.failed.length" class="panel-section">
        <div class="panel-section-title"><h2>填写结果</h2><small>已填写 {{ report.filled.length }} · 原值保留 {{ report.kept.length }} · 未填写 {{ report.pending.length }} · 失败 {{ report.failed.length }}</small></div>
      </section>

      <section v-if="fields.length" class="panel-section field-list">
        <div class="panel-section-title"><h2>网页字段（{{ fields.length }}）</h2><small>按匹配、填写结果和置信度状态切换</small></div>
        <div class="field-tabs" role="tablist">
          <button v-for="tab in fieldTabs" :key="tab.id" type="button" role="tab" :class="{ active: activeTab?.id === tab.id }" :aria-selected="activeTab?.id === tab.id" @click="activeFieldTab = tab.id">{{ tab.label }} <em>{{ tab.rows.length }}</em></button>
        </div>
        <template v-if="activeTab">
          <div v-for="field in activeTab.rows" :key="field.id" :class="['field-card', { 'needs-confirmation': fieldReviewBucket(field) === 'pending' || fieldNeedsAttention(field) }]">
            <div class="field-title">
              <strong>{{ field.label || field.placeholder || '未命名字段' }}</strong>
              <span class="tag">{{ field.kind }}</span>
              <span :class="['tag', fieldStateChip(field).tone === 'ok' ? 'success-text' : fieldStateChip(field).tone === 'warn' ? 'warning-text' : '']">{{ fieldStateChip(field).text }}</span>
            </div>
            <select v-model="selections[field.id]" @change="selectionChanged(field)">
              <option value="">留空 / 手动填写</option>
              <option v-for="fact in allFacts" :key="fact.id" :value="fact.id">{{ factLabel(fact) }}</option>
            </select>
            <small v-if="matchSummary(field.id)" :class="resolutions[field.id]?.status === 'needs-confirmation' ? 'warning-text' : 'success-text'">{{ matchSummary(field.id) }}</small>
            <small class="diagnostic-line">漏斗：{{ diagnosticDetail(field) }}</small>
            <button class="assist-one" :disabled="busy || !selections[field.id]" @click="manualFill(field)">填入此字段</button>
            <small v-if="results[field.id]" :class="resultTone(results[field.id])">{{ resultDetail(results[field.id]) }}</small>
            <button v-if="results[field.id]?.status === 'failed'" class="assist-one" :disabled="busy" @click="fill(field.id)">重试该字段</button>
          </div>
        </template>
      </section>

      <section v-if="polishableFields.length" class="panel-section polish-panel"><h2>AI 润色开放文本</h2><select v-model="selectedPolishField" @change="maxLength = selectedField?.maxLength || 300"><option value="">选择要润色的字段</option><option v-for="field in polishableFields" :key="field.id" :value="field.id">{{ field.label || field.placeholder || field.id }}</option></select><textarea v-model="jobDescription" rows="2" placeholder="岗位要求（可选）"></textarea><div class="panel-action-row"><button :disabled="busy || !selectedPolishField || !aiReady" @click="polish">生成建议</button></div><div v-if="polished" class="suggestion"><textarea v-model="suggestion" rows="5"></textarea><small>{{ suggestion.length }} 字，请核对事实</small><button class="panel-primary" @click="adopt">确认采用</button></div></section>
    </div>
  </main>
  <OptionsApp v-else :key="controlView" embedded :initial-view="controlView" @auto-fill="startAutoFillFromHome" @collapse="openCompactView" @fill-fact="manualFillFact" @deactivated="onLicenseCleared" />
  </template>
</template>

<style scoped>
.visual-health-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 6px 0;
  color: #64748b;
  font-size: 10px;
  line-height: 1.4;
}
.visual-health-line > span { color: #f59e0b; font-size: 8px; }
.visual-health-line > span.ready { color: #22c55e; }
.visual-health-line button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
  font-size: 10px;
}
.visual-health-line button:disabled { color: #94a3b8; cursor: default; }
.diagnostic-funnel {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin: 7px 0;
  padding: 7px 9px;
  border: 1px solid #dbeafe;
  border-radius: 9px;
  background: #f8fbff;
  color: #475569;
  font-size: 10px;
}
.diagnostic-funnel i { color: #94a3b8; font-style: normal; }
.diagnostic-funnel button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
  font-size: 10px;
}
.diagnostic-funnel button:disabled { color: #94a3b8; cursor: default; }
.diagnostic-line { color: #64748b; line-height: 1.45; overflow-wrap: anywhere; }
.activation-shell {
  width: 116.28%;
  height: 116.28%;
  overflow: hidden;
  padding: 1px;
  color: #0b1d43;
  background: transparent;
  transform: scale(.86);
  transform-origin: top left;
}

.activation-card {
  height: 100%;
  overflow: hidden;
  border: 1px solid rgba(210, 221, 238, 0.9);
  border-radius: 18px;
  background: linear-gradient(145deg, #fff 0%, #fbfdff 72%, #f4f8ff 100%);
  box-shadow: 0 16px 44px rgba(23, 48, 88, 0.2);
}

.activation-hero {
  position: relative;
  display: flex;
  min-height: 112px;
  align-items: center;
  overflow: hidden;
  padding: 16px 26px;
  background:
    radial-gradient(circle at 82% 55%, rgba(190, 222, 255, 0.72), transparent 28%),
    linear-gradient(105deg, #fff 2%, #f8fbff 58%, #eef6ff 100%);
}

.activation-hero::after {
  position: absolute;
  right: 166px;
  bottom: -68px;
  width: 180px;
  height: 150px;
  border-radius: 50%;
  background: rgba(211, 231, 255, 0.64);
  content: "";
}

.activation-brand {
  z-index: 2;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
}

.activation-brand img {
  width: 72px;
  height: 72px;
  flex: 0 0 72px;
  border-radius: 18px;
  box-shadow: 0 10px 26px rgba(29, 107, 235, 0.17);
}

.activation-brand h1 {
  margin: 0;
  font-size: clamp(24px, 3.5vw, 32px);
  line-height: 1.12;
  letter-spacing: -1.2px;
}

.activation-brand p {
  margin: 6px 0 0;
  color: #66748e;
  font-size: clamp(14px, 1.8vw, 18px);
}

.activation-mascot {
  position: absolute;
  z-index: 1;
  right: 26px;
  bottom: -64px;
  width: 190px;
  height: 190px;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.activation-close {
  position: absolute;
  z-index: 4;
  top: 13px;
  right: 18px;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #65718a;
  font-size: 40px;
  font-weight: 300;
  line-height: 36px;
}

.activation-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 0.78fr);
  gap: 12px 18px;
  padding: 0 26px 18px;
}

.activation-info {
  grid-column: 1 / -1;
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border: 1px solid #d9eaff;
  border-radius: 16px;
  background: linear-gradient(100deg, #edf6ff, #f5faff);
}

.activation-info > span {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 50%;
  background: #1477f8;
  color: #fff;
  font-size: 18px;
  font-family: Georgia, serif;
  font-weight: 700;
}

.activation-info p {
  margin: 0;
  color: #183965;
  font-size: 15px;
  font-weight: 600;
}

.activation-notice {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 1px solid #dfe9f6;
  border-radius: 16px;
  background: #f9fbff;
}

.notice-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 10px;
  background: linear-gradient(145deg, #ffdc69, #ffb92e);
  color: #fff;
  font-size: 17px;
}

.activation-notice h2 {
  margin: 0 0 5px;
  font-size: 15px;
}

.activation-notice p {
  margin: 0 0 3px;
  color: #536781;
  font-size: 11.5px;
  line-height: 1.42;
}

.activation-notice p:last-child { margin-bottom: 0; }
.activation-notice strong { color: #1268e8; }

.activation-form {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.activation-form > label {
  margin: 0 0 8px;
  font-size: 21px;
  font-weight: 800;
}

.activation-input-wrap { position: relative; }

.activation-input-wrap input {
  width: 100%;
  height: 50px;
  padding: 0 48px 0 16px;
  border: 2px solid #d5dfef;
  border-radius: 14px;
  background: #fff;
  font-size: 15px;
}

.activation-input-wrap input::placeholder { color: #a5b1c7; }

.clipboard-icon {
  position: absolute;
  top: 50%;
  right: 18px;
  color: #64728c;
  font-size: 24px;
  transform: translateY(-50%);
}

.activation-error {
  display: flex;
  min-height: 22px;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  color: #f01f35;
  font-size: 13px;
}

.activation-error span {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border: 2px solid currentColor;
  border-radius: 50%;
  font-weight: 800;
}

.activation-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: auto;
  padding-top: 12px;
}

.activation-actions button {
  min-width: 96px;
  height: 42px;
  border-radius: 13px;
  font-size: 15px;
  font-weight: 800;
}

.activation-cancel {
  border: 2px solid #d5dfef;
  background: #fff;
  color: #64718a;
}

.activation-submit {
  border: 0;
  background: linear-gradient(115deg, #0868f5, #0b7dff);
  color: #fff;
  box-shadow: 0 10px 24px rgba(11, 112, 248, 0.22);
}

.activation-loading {
  display: flex;
  min-height: 300px;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #526784;
  font-size: 15px;
}

.activation-loading span {
  width: 22px;
  height: 22px;
  border: 3px solid #dbe9fb;
  border-top-color: #1477f8;
  border-radius: 50%;
  animation: activation-spin 0.8s linear infinite;
}

@keyframes activation-spin { to { transform: rotate(360deg); } }

/* Compact panel: visual-only refresh; all existing actions remain wired as before. */
.compact-mode {
  width: 106.383% !important;
  height: 106.383% !important;
  padding: 0 !important;
  border: 1px solid #c9d9ed;
  border-radius: 16px;
  background: linear-gradient(155deg, #fff 0%, #f8fbff 54%, #f2f8ff 100%) !important;
  box-shadow: inset 0 1px 0 #fff, 0 18px 46px rgba(36, 74, 127, 0.18);
  transform: scale(.94);
  transform-origin: top left;
}

.popup.expanded {
  width: 113.637% !important;
  height: 113.637% !important;
  transform: scale(.88);
  transform-origin: top left;
}

.popup.expanded small { font-size: 11px !important; line-height: 1.45; }
.popup.expanded input,
.popup.expanded select,
.popup.expanded textarea,
.popup.expanded .panel-action-row button { font-size: 12px; }

.compact-brand {
  position: relative;
  min-height: 74px;
  flex: 0 0 74px;
  overflow: hidden;
  padding: 10px 12px 8px !important;
  background:
    radial-gradient(circle at 84% 58%, rgba(179, 220, 255, 0.7), transparent 34%),
    linear-gradient(112deg, #fff 5%, #f4f9ff 65%, #eaf5ff 100%);
}

.compact-brand::after {
  position: absolute;
  right: 61px;
  bottom: -43px;
  width: 102px;
  height: 82px;
  border-radius: 50%;
  background: rgba(205, 230, 255, 0.74);
  content: "";
}

.compact-brand-icon {
  z-index: 2;
  display: grid;
  width: 43px;
  height: 43px;
  flex: 0 0 43px;
  place-items: center;
  overflow: hidden;
  border-radius: 12px;
  background: linear-gradient(145deg, #69dff1, #1684f8);
  box-shadow: 0 8px 18px rgba(19, 113, 220, 0.18);
}

.compact-brand-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.compact-brand-copy {
  z-index: 3;
  align-self: center;
}

.compact-brand-copy h1 {
  color: #071738;
  font-size: 16px !important;
  line-height: 1.15;
  letter-spacing: -0.6px;
}

.compact-brand-copy p {
  margin-top: 4px !important;
  color: #5e708f !important;
  font-size: 11px !important;
}

.compact-hero-mascot {
  position: absolute;
  z-index: 2;
  right: 12px;
  bottom: -12px;
  width: 84px;
  height: 63px;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.compact-top-close {
  position: absolute;
  z-index: 4;
  top: 6px;
  right: 7px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #60708d;
  font-size: 26px;
  font-weight: 300;
  line-height: 23px;
}

.compact-mode .compact-content { padding: 0 10px 6px; overflow-anchor: none; }

.compact-mode .ready-card {
  min-height: 48px;
  gap: 9px;
  padding: 7px 10px;
  border-color: #cfdeef;
  border-radius: 14px;
  box-shadow: 0 5px 15px rgba(57, 91, 136, 0.05);
}

.compact-mode .ready-card > span {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border: 5px solid #edf2f8;
  background: #91a4c0;
  font-size: 18px;
  box-shadow: 0 0 0 1px #dfe9f4;
}

.compact-mode .ready-card.online > span {
  border-color: #e3f8ef;
  background: linear-gradient(145deg, #27bd77, #039651);
  box-shadow: 0 5px 12px rgba(4, 151, 83, 0.2);
}

.compact-mode .ready-card.loading > span {
  border-color: #e0efff;
  background: linear-gradient(145deg, #1686f7, #09b8c6);
  box-shadow: 0 5px 12px rgba(9, 133, 214, 0.22);
}

.compact-mode .ready-card b { color: #0c8050; font-size: 14px; }
.compact-mode .ready-card small { margin-top: 1px; color: #597094; font-size: 10px; }
.compact-mode .ready-card i { color: #5f7090; font-size: 26px; font-weight: 300; }

.compact-mode .panel-auto {
  height: 46px;
  margin: 7px 0;
  gap: 10px;
  border: 1px solid rgba(31, 149, 232, 0.25);
  border-radius: 14px;
  background: linear-gradient(105deg, #126ef3 0%, #08a9dd 52%, #10c993 100%);
  box-shadow: 0 10px 22px rgba(4, 154, 187, 0.2);
}

.compact-mode .panel-auto span { font-size: 22px; }
.compact-mode .panel-auto b { font-size: 17px; }
.compact-mode .panel-auto i { font-size: 16px; }

.auto-fill-spinner {
  display: block;
  width: 18px;
  height: 18px;
  border: 3px solid rgba(255, 255, 255, 0.42);
  border-top-color: #fff;
  border-radius: 50%;
  animation: auto-fill-spin 0.72s linear infinite;
}

.ready-card .auto-fill-spinner {
  width: 16px;
  height: 16px;
}

@keyframes auto-fill-spin { to { transform: rotate(360deg); } }

.compact-mode .panel-assist {
  position: relative;
  height: 38px;
  gap: 8px;
  border-color: #cbdced;
  border-radius: 14px;
  box-shadow: 0 5px 15px rgba(57, 91, 136, 0.04);
}

.compact-mode .panel-assist span {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border: 2px solid #388eea;
  border-radius: 50%;
  font-size: 13px;
}

.compact-mode .panel-assist b { font-size: 14px; }
.compact-mode .panel-assist i {
  position: absolute;
  right: 13px;
  color: #7183a3;
  font-size: 24px;
  font-style: normal;
  font-weight: 300;
}

.compact-mode .knowledge-home {
  margin-top: 7px;
  padding: 8px;
  border-color: #d3e0ee;
  border-radius: 14px;
  box-shadow: 0 5px 15px rgba(57, 91, 136, 0.04);
}

.compact-mode .knowledge-home .panel-section-title {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
}

.compact-mode .knowledge-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 10px;
  background: linear-gradient(145deg, #edf5ff, #ddebff);
  color: #2679e9;
  font-size: 16px;
}

.compact-mode .knowledge-home h2 { font-size: 12px; }
.compact-mode .knowledge-home small { font-size: 10px; }

.compact-mode .knowledge-home .panel-section-title button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 7px;
  border: 1px solid #d5e5f7;
  border-radius: 9px;
  background: #f8fbff;
  font-size: 10px;
  font-weight: 700;
}

.compact-mode .knowledge-home .panel-section-title button span { font-size: 14px; }

.compact-mode .knowledge-empty,
.compact-mode .knowledge-hint {
  min-height: 36px;
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  background: linear-gradient(105deg, #f7faff, #f2f7fd);
  color: #5c7093;
  font-size: 10px;
  line-height: 1.45;
}

.compact-mode .panel-status {
  min-height: 27px;
  margin: 5px 0 0;
  padding: 6px 8px;
  border-radius: 11px;
  background: linear-gradient(100deg, #e2f8f0, #eaf8fb);
  color: #125b55;
  font-size: 10px;
}

.compact-mode .panel-status::before {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: #0cac67;
  content: "";
}

.compact-mode .panel-status.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  background: linear-gradient(100deg, #e6f2ff, #e8fbfa);
  color: #165b85;
}

.compact-mode .panel-status.loading::before { display: none; }

.inline-loading {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  border: 2px solid rgba(22, 112, 181, 0.22);
  border-top-color: #1676c8;
  border-radius: 50%;
  animation: auto-fill-spin 0.72s linear infinite;
}

.compact-mode .panel-footer {
  min-height: 46px;
  margin: 0 !important;
  padding: 4px 11px 5px;
  border-color: #d7e2ef;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 -5px 15px rgba(50, 79, 119, 0.04);
}

.compact-mode .panel-footer button { gap: 1px; color: #172d56; font-size: 11px; }
.compact-mode .panel-footer span { font-size: 19px; }

@media (max-width: 280px) {
  .compact-brand-icon { width: 44px; height: 44px; flex-basis: 44px; }
  .compact-brand-copy h1 { font-size: 15px !important; }
  .compact-hero-mascot { opacity: 0.42; }
  .compact-mode .knowledge-home .panel-section-title { grid-template-columns: 32px minmax(0, 1fr); }
  .compact-mode .knowledge-home .panel-section-title button { grid-column: 1 / -1; justify-self: end; }
}

@media (max-width: 520px) {
  .activation-card { overflow: auto; }
  .activation-hero { min-height: 112px; padding: 18px; }
  .activation-brand { gap: 12px; }
  .activation-brand img { width: 64px; height: 64px; flex-basis: 64px; border-radius: 16px; }
  .activation-brand h1 { font-size: 22px; }
  .activation-brand p { margin-top: 5px; font-size: 13px; }
  .activation-mascot { right: 4px; bottom: -44px; width: 150px; height: 150px; opacity: 0.55; }
  .activation-close { top: 7px; right: 10px; }
  .activation-body { grid-template-columns: 1fr; gap: 13px; padding: 0 16px 18px; }
  .activation-info { min-height: 52px; padding: 10px 13px; }
  .activation-info p { font-size: 13px; }
  .activation-notice { padding: 13px; }
  .activation-form > label { margin-bottom: 8px; font-size: 20px; }
  .activation-input-wrap input { height: 52px; font-size: 14px; }
  .activation-actions { margin-top: 0; padding-top: 13px; }
}

@media (max-height: 400px) {
  .activation-card { overflow: auto; }
}

.ai-prompt-mask {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(18, 34, 61, 0.45);
}

.ai-prompt {
  display: grid;
  gap: 8px;
  width: min(360px, 100%);
  padding: 16px;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 16px 44px rgba(18, 34, 61, 0.3);
}

.ai-prompt h2 {
  margin: 0;
  font-size: 15px;
}

.ai-prompt p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #516589;
}

.ai-prompt-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.ai-prompt-actions button {
  flex: 1;
}

.field-tabs {
  display: flex;
  gap: 6px;
  margin: 8px 0;
  overflow-x: auto;
}

.field-tabs button {
  flex: none;
  max-width: 148px;
  overflow: hidden;
  padding: 4px 10px;
  border: 1px solid #d5e0ef;
  border-radius: 999px;
  background: #fff;
  color: #3d5274;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-tabs button em {
  margin-left: 4px;
  font-style: normal;
  opacity: 0.7;
}

.field-tabs button.active {
  border-color: #087af2;
  background: #087af2;
  color: #fff;
}

.knowledge-home {
  margin-top: 12px;
}

.knowledge-home .panel-section-title {
  align-items: flex-start;
  gap: 8px;
}

.knowledge-home .panel-section-title > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.knowledge-home .panel-section-title button {
  flex: none;
  border: 0;
  background: transparent;
  color: #087af2;
  font-size: 11px;
}

.knowledge-empty,
.knowledge-hint {
  margin: 8px 0 0;
  color: #6b7c99;
  font-size: 11px;
  line-height: 1.5;
}

.knowledge-hint {
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff8e8;
  color: #8a5a12;
}

.learned-list {
  max-height: 220px;
  margin-top: 6px;
  overflow-y: auto;
  overflow-anchor: none;
  scroll-padding-bottom: 12px;
}

.learned-row:last-child {
  scroll-margin-bottom: 8px;
}

.learned-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 2px;
  font-size: 11px;
  border-bottom: 1px dashed #e3ebf6;
}

.learned-body {
  display: grid;
  flex: 1;
  gap: 3px;
  min-width: 0;
}

.learned-row .learned-meta {
  color: #5b6b8c;
  line-height: 1.4;
  word-break: break-all;
}

.learned-row .learned-meta em {
  font-style: normal;
  color: #b05d16;
}

.learned-row .learned-meta b {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 6px;
  font-weight: 700;
  color: #fff;
}

.learned-row .learned-meta b.supplement { background: #087af2; }
.learned-row .learned-meta b.correction { background: #e28a13; }

.learned-previous {
  color: #8a93a6;
  text-decoration: line-through;
}

.learned-body input {
  width: 100%;
  box-sizing: border-box;
  padding: 3px 6px;
  border: 1px solid #d5e0ef;
  border-radius: 6px;
  font-size: 12px;
}
</style>
