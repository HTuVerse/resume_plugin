<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { polishText, suggestSlotMatches } from '../../application/api'
import { buildFactIndex, resolveField, type FactIndex } from '../../features/autofill/dataResolver'
import { factToSlot } from '../../features/autofill/match/factToSlot'
import { aliasHit, aliasSectionCount, slotById } from '../../features/ontology/slotRegistry'
import { getCachedSuggestions, putCachedSuggestions } from '../../features/ai/slotMatchCache'
import { learnAlias } from '../../features/ontology/learnedAliases'
import { classifyPageInput, knowledgeIdentity, mergeIntoKnowledge, type LearnedEntry } from '../../features/rag/knowledge'
import { alignFamilyItem, familyItemForRelation, isFamilyField, isRelationField, relationKey } from '../../features/autofill/familyAlign'
import { alignNamedItem, dateSlotId, fillNamedItem, nameSlotId, namedSectionOf } from '../../features/autofill/namedSegment'
import { recordCorrection, recordFailure, recordHit } from '../../features/siteRules/ruleStore'
import { beginPanelDrag, closePanel, onContentEvent, requestContent, resizePanel } from '../bridge/panelBridge'
import { loadAiSettings, loadCurrentResume, loadProfile, saveProfile } from '../../infrastructure/storage/store'
import { activate, loadLicense, type LicenseRecord } from '../../features/license/license'
import type { AiSettings, CurrentResume, Fact, FillRequest, FillResult, FormField, PageContext, ResolvedField, SlotSuggestion } from '../../domain/types'
import OptionsApp from './OptionsApp.vue'
import { mergeFactsByPriority } from '../../features/autofill/factPriority'

const facts = ref<Fact[]>([])
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
/**
 * 网页学习候选：自动观察网页上的填写得出。
 * supplement = 插件没填、用户补充的；correction = 插件填了、用户改过的。
 * 确认前可在线编辑 value，确认后才写入知识库。
 */
const learned = ref<Array<LearnedEntry & { selected: boolean; origin: 'supplement' | 'correction'; previous: string; fieldId: string; pageValue?: string }>>([])
const learnedListEl = ref<HTMLElement | null>(null)
const featureSettings = reactive({ autoClipboard: true, aiMapping: true, miniPanel: true, aiMatchThreshold: 85 })
const selectedField = computed(() => fields.value.find(field => field.id === selectedPolishField.value))
const polishableFields = computed(() => fields.value.filter(field => field.kind === 'textarea'
  || /自我评价|个人优势|自我介绍|职业目标|工作内容|项目描述|职责|description|summary/i.test(`${field.label} ${field.placeholder}`)))

const aiReady = computed(() => Boolean(aiSettings.value.url && aiSettings.value.key && aiSettings.value.model))
// 知识库（我的信息）是唯一填充数据源
const allFacts = computed(() => mergeFactsByPriority(facts.value))
const factIndex = computed<FactIndex>(() => buildFactIndex(facts.value))
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

/**
 * 自动填写把本页能写的字段写完之后才为 true。
 * 为 false 时不吸收、不保存网页上的修改。
 */
const knowledgeWatch = ref(false)

const FIELD_REVIEW_TABS = [
  { id: 'pending', label: '待确认' },
  { id: 'confirmed', label: '已确认' },
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
  if (result?.status === 'filled' && result.source === 'ai') return 'pending'
  if (result?.status === 'filled') return 'filled'
  if (result?.status === 'skipped') return 'kept'
  const resolution = resolutions[field.id]
  if (!resolution || resolution.status === 'empty') return 'empty'
  if (resolution.status === 'needs-confirmation') return 'pending'
  if (resolution.status === 'ready') return 'confirmed'
  if (resolution.status === 'skipped') return 'kept'
  return 'empty'
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
  currentResume.value = await loadCurrentResume()
  aiSettings.value = await loadAiSettings()
  const storedFeatures = await chrome.storage.local.get('featureSettingsV1')
  if (storedFeatures.featureSettingsV1) Object.assign(featureSettings, storedFeatures.featureSettingsV1)
  const settingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.featureSettingsV1?.newValue) Object.assign(featureSettings, changes.featureSettingsV1.newValue)
  }
  chrome.storage.onChanged.addListener(settingsChanged)
  removeSettingsEvents = () => chrome.storage.onChanged.removeListener(settingsChanged)
  removeContentEvents = onContentEvent(event => {
    if (event?.type === 'PAGE_MUTATED') {
      // F16：只提示不动作
      newFieldsHint.value = event.added || 0
      return
    }
    if (event?.type === 'FIELD_OBSERVED') {
      if (!knowledgeWatch.value) return
      const field = fields.value.find(item => item.id === event.fieldId)
      if (field) noteObservedValue(field, String(event.value || ''))
      return
    }
    if (event?.type !== 'PICKER_RESULT') return
    pickerActive.value = false
    if (event.result) results[event.result.fieldId] = event.result
    status.value = event.result?.status === 'filled' ? '已完成手动辅助填写，并复制到剪贴板。' : event.result?.message || '手动辅助填写失败。'
  })
  if (!license.value) return
  if (!featureSettings.miniPanel) openControl('home')
  await scan()
})

onUnmounted(() => {
  stopLearnedWatch()
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

function openFillView() { showingControl.value = false; expanded.value = true; resizePanel('expanded') }
function openCompactView() { showingControl.value = false; expanded.value = false; resizePanel('compact') }
function dragFromHeader(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('button, input, textarea, a')) return
  event.preventDefault()
  beginPanelDrag(event.clientX, event.clientY)
}

function familyPeers(field: FormField): FormField[] {
  if (!isFamilyField(field)) return []
  return fields.value.filter(other => {
    if (!isFamilyField(other)) return false
    if (field.repeatGroupId && other.repeatGroupId) return other.repeatGroupId === field.repeatGroupId
    return Math.max(1, other.item || 1) === Math.max(1, field.item || 1)
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
  if (!relation) return undefined
  return familyItemForRelation(allFacts.value, relation) ?? null
}

function namedPeers(field: FormField): FormField[] {
  const section = namedSectionOf(field)
  if (!section) return []
  return fields.value.filter(other => {
    if (namedSectionOf(other) !== section) return false
    if (field.repeatGroupId && other.repeatGroupId) return other.repeatGroupId === field.repeatGroupId
    return Math.max(1, other.item || 1) === Math.max(1, field.item || 1)
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
    pageItem: Math.max(1, field.item || 1),
    name: name.present ? name.value : undefined,
    date: date.value,
    facts: allFacts.value
  }
}

/** 填写时按名称对齐。不是按名称对齐的板块时返回 undefined，沿用页面段号。 */
function namedSegmentItem(field: FormField): number | null | undefined {
  const input = namedAlignInput(field)
  if (!input) return undefined
  return fillNamedItem(input)
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
    if (existing && existing.value.trim() === next.fact.value.trim()) return []
    next.previous = existing?.value || ''
    return [next]
  })
}

function resolveOne(field: FormField): void {
  const resolved = resolveField(field, factIndex.value, {
    aiSuggestion: aiSuggestions[field.id],
    aiMatchThreshold: featureSettings.aiMatchThreshold,
    segmentItem: isFamilyField(field) ? familySegmentItem(field) : namedSegmentItem(field)
  })
  resolutions[field.id] = resolved
  selections[field.id] = resolved.factId && (resolved.status === 'ready' || resolved.status === 'needs-confirmation') ? resolved.factId : ''
}

/** 未配置 AI 时的选择：去配置 / 立即填充 / 未决定。 */
const aiPrompt = ref<'pending' | null>(null)

async function autoFill() {
  autoFillRunning.value = true
  status.value = '正在准备自动填写…'
  try {
    aiSettings.value = await loadAiSettings()
    // 没配置 AI 时先询问：配置后识别更准确，也可以跳过直接按字段名填充
    if (featureSettings.aiMapping && !aiReady.value) { aiPrompt.value = 'pending'; return }
    await runAutoFill()
  } finally {
    autoFillRunning.value = false
  }
}

async function runAutoFill() {
  // 识别页面 →（已配置 AI 时）分析表单字段含义 → 按知识库匹配 → 填写
  // 这一轮写完之前不监测网页修改，避免把填写过程本身学进知识库。
  knowledgeWatch.value = false
  learned.value = []
  await scan()
  if (!fields.value.length) { status.value = '当前页面没有发现可填写的表单字段。'; return }
  if (featureSettings.aiMapping && aiReady.value) await aiMatch()
  if (Object.values(selections).some(Boolean)) await fill(undefined, { armKnowledgeWatch: true })
  else status.value = '没有可填写的字段：知识库中没有与本页字段对应的数据，请先完善「我的信息」。监测尚未开始。'
}

function goConfigureAi() {
  aiPrompt.value = null
  openControl('settings')
}

async function fillWithoutAi() {
  aiPrompt.value = null
  autoFillRunning.value = true
  try { await runAutoFill() }
  finally { autoFillRunning.value = false }
}

async function startAutoFillFromHome() {
  showingControl.value = false
  expanded.value = false
  resizePanel('compact')
  await autoFill()
}

async function scan() {
  busy.value = true
  status.value = '正在读取当前页面…'
  fields.value = []
  suggestion.value = ''
  newFieldsHint.value = 0
  learned.value = []
  try {
    facts.value = tagFacts((await loadProfile()).facts, 'profile')
    const response = await requestContent({ type: 'SCAN' })
    if (response.error) throw new Error(response.error)
    fields.value = response.fields || []
    pageContext.value = response.context || null
    for (const key of Object.keys(aiSuggestions)) delete aiSuggestions[key]
    for (const field of fields.value) {
      resolveOne(field)
      delete results[field.id]
    }
    const ready = Object.values(resolutions).filter(item => item.status === 'ready').length
    const pending = Object.values(resolutions).filter(item => item.status === 'needs-confirmation').length
    const frames = pageContext.value?.frames?.length || 1
    status.value = `识别 ${fields.value.length} 个字段（${frames > 1 ? `${frames} 个 frame，` : ''}已确认 ${ready} 个，待确认 ${pending} 个）。`
  } catch (error) { status.value = error instanceof Error ? error.message : '页面识别失败。' }
  finally { busy.value = false }
}

/**
 * AI 分析表单（两步填充的第一步）：把整张表单的字段元信息交给 AI，
 * 判断每个字段在问什么（映射到知识库槽位）；本地规则已精确命中的字段跳过。
 * AI 只输出槽位、不接触个人数据，填值仍由知识库连接 + 校验闸门完成（F42）。
 */
async function aiMatch() {
  const pending = fields.value.filter(field => !field.current.trim() && resolutions[field.id]?.status !== 'ready')
  if (!pending.length) {
    status.value = '所有空字段都已精确匹配到知识库，无需 AI 分析。'
    return
  }
  busy.value = true
  status.value = `正在让 AI 分析 ${pending.length} 个字段的含义…`
  try {
    aiSettings.value = await loadAiSettings()
    const domain = pageDomain()
    // 先查缓存（F43）：同站同指纹不重复请求
    const cached = await getCachedSuggestions(domain, pending.map(field => ({ fieldId: field.id, fingerprint: field.fingerprint })))
    const cachedIds = new Set(cached.map(item => item.fieldId))
    const remaining = pending.filter(field => !cachedIds.has(field.id))
    let fresh: SlotSuggestion[] = []
    if (remaining.length) {
      if (!aiReady.value) throw new Error('请先在档案设置中保存 API URL、API Key 和模型名称。')
      fresh = await suggestSlotMatches(remaining, allFacts.value, aiSettings.value)
      await putCachedSuggestions(domain, fresh.flatMap(item => {
        const field = fields.value.find(candidate => candidate.id === item.fieldId)
        return field ? [{ fingerprint: field.fingerprint, suggestion: item }] : []
      }))
    }
    let adopted = 0
    for (const item of [...cached, ...fresh]) {
      const field = fields.value.find(candidate => candidate.id === item.fieldId)
      if (!field || !slotById(item.slot)) continue
      aiSuggestions[field.id] = item
      resolveOne(field)
      if (resolutions[field.id]?.status === 'ready' || resolutions[field.id]?.status === 'needs-confirmation') adopted += 1
    }
    const unmatched = pending.length - adopted
    status.value = `AI 分析完成：${adopted} 个字段已对应到知识库并取到值（其中缓存命中 ${cached.length} 个）${unmatched > 0 ? `，${unmatched} 个字段知识库没有对应数据` : ''}。请核对后点击「填写匹配字段」。`
  } catch (error) { status.value = error instanceof Error ? error.message : 'AI 匹配失败。' }
  finally { busy.value = false }
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
    // 字段措辞学习：该标签成为该槽位的别名，下次任何网站出现相同标签直接命中
    if (field.label.trim()) learnAlias(field.label, slot).catch(() => undefined)
    const domain = pageDomain()
    if (domain && slot !== field.slot) {
      try {
        await recordCorrection(domain, field.fingerprint, slot)
        status.value = `已记录该站点的字段规则（${field.label || field.fingerprint} → ${slotById(slot)?.aliases[0] || slot}），下次自动命中。`
      } catch { /* 学习失败不影响填写 */ }
    }
  }
}

async function fill(onlyFieldId?: string, options?: { armKnowledgeWatch?: boolean }) {
  const targets = onlyFieldId ? fields.value.filter(field => field.id === onlyFieldId) : fields.value
  // 硬约束：宁可留空并提示，不可猜填——批量填写只写入「明确」字段；
  // 待确认字段需用户在下拉中确认（确认后状态变为 ready）或单项填写。
  const pendingCount = onlyFieldId ? 0 : targets.filter(field => resolutions[field.id]?.status === 'needs-confirmation').length
  const emptyCount = onlyFieldId ? 0 : targets.filter(field => resolutions[field.id]?.status === 'empty').length
  const eligible = onlyFieldId ? targets : targets.filter(field => resolutions[field.id]?.status === 'ready')
  const values: FillRequest[] = eligible.flatMap(field => {
    const resolution = resolutions[field.id]
    const fact = allFacts.value.find(item => item.id === selections[field.id])
    const value = fact?.value || resolution?.value
    if (!value || !selections[field.id]) return []
    return [{
      fieldId: field.id,
      value: resolution?.value || value,
      overwrite: Boolean(onlyFieldId),
      source: resolution?.source === 'empty' ? fact?.source : resolution?.source,
      confidence: resolution?.confidence,
      slot: resolution?.slot
    }]
  })
  if (!values.length) {
    const watchNote = options?.armKnowledgeWatch ? '监测尚未开始。' : ''
    status.value = pendingCount
      ? `没有达到自动填写阈值的字段；${pendingCount} 个待确认（低于匹配阈值或选项需核对）请先在下拉中逐项确认。${watchNote}`
      : `请先为至少一个字段选择档案信息。${watchNote}`
    return
  }
  busy.value = true
  try {
    const response = await requestContent({ type: 'FILL', values })
    if (response.error) throw new Error(response.error)
    for (const result of response.results as FillResult[]) {
      results[result.fieldId] = result
      // 站点规则命中统计（F25/§12.2）：命中规则的字段成功计 hit、失败计 fail
      const field = fields.value.find(item => item.id === result.fieldId)
      if (field?.ruleId) {
        if (result.status === 'filled') recordHit(field.ruleId).catch(() => undefined)
        else if (result.reasonCode === 'no-matching-option' || result.reasonCode === 'rejected-by-validation') {
          recordFailure(field.ruleId).catch(() => undefined)
        }
      }
    }
    const rows = response.results as FillResult[]
    const filled = rows.filter(result => result.status === 'filled').length
    const kept = rows.filter(result => result.status === 'skipped').length
    const failed = rows.filter(result => result.status === 'failed').length
    if (options?.armKnowledgeWatch) {
      knowledgeWatch.value = true
      learned.value = []
    }
    const watchNote = options?.armKnowledgeWatch ? '填写已完成，正在监测你之后在网页上的修改。' : ''
    status.value = `已填写 ${filled} 项，原值保留 ${kept} 项，失败 ${failed} 项${pendingCount ? `；${pendingCount} 个待确认（低于匹配阈值或选项需核对）未自动填写` : ''}${emptyCount ? `；${emptyCount} 个字段知识库无数据` : ''}。${watchNote}提交前请检查网页。`
  } catch (error) { status.value = error instanceof Error ? error.message : '填写失败。' }
  finally { busy.value = false }
}

/** 新增一行后把列表和所在表单滚到底，避免新行被下方按钮挡住。 */
function revealLatestLearned(): void {
  nextTick(() => {
    const list = learnedListEl.value
    if (!list) return
    list.scrollTop = list.scrollHeight
    const row = list.lastElementChild instanceof HTMLElement ? list.lastElementChild : null
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

/**
 * 把网页上的一个字段值整理成知识库候选，先放进待确认列表，不直接写入。
 * 插件刚写入且用户没改、或知识库里已是同一个值时，不列入待确认。
 * 页面上把内容删掉后，对应的待确认项一并去掉。
 * quiet 用于识别时吸收页面上已经填好的内容，不打断当前状态文案。
 */
function noteObservedValue(field: FormField, raw: string, quiet = false): void {
  const now = raw.trim()
  const learnedAt = () => learned.value.findIndex(row => row.fieldId === field.id)
  const drop = () => {
    const index = learnedAt()
    if (index >= 0) learned.value.splice(index, 1)
  }
  if (field.attrs?.type === 'password') return
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
  const changedOnPage = field.current.trim() !== now
  if (written && now === written) {
    drop()
    const named = namedAlignInput(field, { id: field.id, value: now })
    if (named) realignNamedLearned(field, alignNamedItem(named))
    if (!quiet && changedOnPage) status.value = `「${field.label || '该字段'}」仍是已填写的内容，无需更新。`
    return
  }
  const slot = field.slot || resolutions[field.id]?.slot
  const sourceField = slot && slot !== field.slot ? { ...field, slot } : field
  const entry = classifyPageInput(sourceField, now)
  if (!entry) return
  if (isFamilyField(sourceField)) {
    const relation = segmentRelation(sourceField, { id: field.id, value: now }) || (isRelationField(sourceField) ? relationKey(now) : '')
    entry.fact.item = alignFamilyItem(entry.fact.item, relation, allFacts.value)
  }
  const named = namedAlignInput(sourceField, { id: field.id, value: now })
  if (named) {
    entry.fact.item = alignNamedItem(named)
    realignNamedLearned(sourceField, entry.fact.item)
  }
  const existing = allFacts.value.find(fact => knowledgeIdentity(fact) === knowledgeIdentity(entry.fact))
  if (existing && existing.value.trim() === now) {
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
    revealLatestLearned()
  }
  if (!quiet) status.value = `已记录「${entry.fact.key}」→ ${now.slice(0, 24)}。请确认后再更新知识库。`
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
  try {
    const response = await requestContent({ type: 'READ_VALUES' })
    if (response.error || !knowledgeWatch.value) return
    const valueMap = new Map<string, string>((response.values || []).map((row: { fieldId: string; value: string }) => [row.fieldId, row.value]))
    for (const field of fields.value) noteObservedValue(field, valueMap.get(field.id) || '', true)
    const added = learned.value.filter(row => !known.has(row.fieldId))
    if (added.length) revealLatestLearned()
    if (learnedWatchSeen && added.length) {
      status.value = added.length === 1
        ? `已记录「${added[0].fact.key}」→ ${added[0].fact.value.slice(0, 24)}。请确认后再更新知识库。`
        : `监测到 ${added.length} 项修改，已列在下方。请确认后再更新知识库。`
    }
    learnedWatchSeen = true
  } catch { /* 下一轮再读 */ }
  finally { learnedWatchBusy = false }
}

watch(knowledgeWatch, armed => {
  stopLearnedWatch()
  if (!armed) return
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
    const valueMap = new Map<string, string>((response.values || []).map((row: { fieldId: string; value: string }) => [row.fieldId, row.value]))
    for (const field of fields.value) noteObservedValue(field, valueMap.get(field.id) || '', true)
    if (learned.value.length) revealLatestLearned()
    const corrections = learned.value.filter(entry => entry.origin === 'correction').length
    status.value = learned.value.length
      ? `发现 ${learned.value.length - corrections} 条补充、${corrections} 条修正。请在下方核对并编辑，确认无误后再更新知识库。`
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
  facts.value = tagFacts(merged.facts, 'profile')
  await saveProfile(merged.facts)
  for (const entry of chosen) {
    if (entry.slot && entry.fieldLabel.trim() && aliasSectionCount(entry.fieldLabel) < 2) {
      learnAlias(entry.fieldLabel, entry.slot).catch(() => undefined)
    }
  }
  learned.value = []
  status.value = `知识库已更新：新增 ${merged.added} 条、更新 ${merged.updated} 条。下次遇到相同字段会自动匹配。`
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
    if (results[fieldId]) results[fieldId] = { ...results[fieldId], source: 'manual' }
    status.value = '该 AI 匹配结果已确认，字段已恢复正常高亮。'
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
    const response = await requestContent({ type: 'FILL', values: [{ fieldId: selectedPolishField.value, value: suggestion.value.trim(), overwrite: true }] })
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
  if (bucket === 'pending') return { text: `待确认${percent}`, tone: 'warn' }
  if (bucket === 'confirmed') return { text: `已确认${percent}`, tone: 'ok' }
  if (bucket === 'filled') return { text: `已填写${percent}`, tone: 'ok' }
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
  return parts.join(' · ')
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
            <div ref="learnedListEl" class="learned-list">
              <div v-for="entry in learned" :key="entry.fact.id" class="learned-row">
                <input v-model="entry.selected" type="checkbox" :aria-label="`更新 ${entry.fact.key}`" />
                <div class="learned-body">
                  <span class="learned-meta">{{ entry.fact.group }}<template v-if="entry.fact.item > 1"> · 第 {{ entry.fact.item }} 段</template> · {{ entry.fact.key }}<em v-if="entry.custom">（自定义字段）</em><b :class="entry.origin">{{ entry.origin === 'correction' ? '修正' : '补充' }}</b></span>
                  <small v-if="entry.previous" class="learned-previous">知识库原值：{{ entry.previous.slice(0, 40) }}</small>
                  <input v-model="entry.fact.value" type="text" :aria-label="`${entry.fact.key} 的值`" />
                </div>
              </div>
            </div>
            <div class="panel-action-row"><button class="panel-primary" :disabled="busy" @click="saveLearned">确认并更新知识库</button><button @click="learned = []">放弃</button></div>
          </template>
        </section>
        <p :class="['panel-status', { loading: autoFillRunning }]" role="status"><span v-if="autoFillRunning" class="inline-loading"></span>{{ status }}</p>
      </div>
      <footer class="panel-footer shrink-0"><button @click="openControl('settings')"><span>⚙</span>设置</button><button @click="openControl('home')"><span>⛶</span>展开</button><button @click="closePanel"><span>×</span>关闭</button></footer>
    </template>

    <div v-else class="panel-body">
      <div class="panel-toolbar"><button @click="openCompactView">‹ 返回缩小态</button><span>核对匹配</span><button @click="scan">↻ 重新识别</button></div>
      <div class="panel-metrics"><div><b>{{ fields.length }}</b><small>识别字段</small></div><div><b>{{ matchedCount }}</b><small>成功匹配</small></div><div><b>{{ report.filled.length }}</b><small>已填写</small></div><div><b>{{ report.failed.length }}</b><small>失败</small></div></div>
      <p v-if="newFieldsHint" class="picker-notice">页面出现 {{ newFieldsHint }} 个新字段。<button @click="scan">重新识别</button></p>
      <p v-if="pickerActive" class="picker-notice">请点击网页中的目标输入框。<button @click="cancelPicker">取消</button></p>
      <p class="panel-status" role="status">{{ status }}</p>
      <div class="panel-action-row"><button class="panel-primary" :disabled="busy" @click="fill()">填写匹配字段</button><button :disabled="busy || !fields.length || !featureSettings.aiMapping" :title="aiReady ? '让 AI 读懂表单每个字段在问什么，再按知识库取值（值仍经校验）' : '请先配置 AI'" @click="aiMatch">AI 分析表单</button><button @click="undo">撤销</button></div>

      <section v-if="report.filled.length || report.kept.length || report.failed.length" class="panel-section">
        <div class="panel-section-title"><h2>填写结果</h2><small>已填写 {{ report.filled.length }} · 原值保留 {{ report.kept.length }} · 待确认 {{ report.pending.length }} · 失败 {{ report.failed.length }}</small></div>
      </section>

      <section v-if="fields.length" class="panel-section field-list">
        <div class="panel-section-title"><h2>网页字段（{{ fields.length }}）</h2><small>按待确认、已确认、填写结果和置信度状态切换</small></div>
        <div class="field-tabs" role="tablist">
          <button v-for="tab in fieldTabs" :key="tab.id" type="button" role="tab" :class="{ active: activeTab?.id === tab.id }" :aria-selected="activeTab?.id === tab.id" @click="activeFieldTab = tab.id">{{ tab.label }} <em>{{ tab.rows.length }}</em></button>
        </div>
        <template v-if="activeTab">
          <div v-for="field in activeTab.rows" :key="field.id" :class="['field-card', { 'needs-confirmation': fieldReviewBucket(field) === 'pending' }]">
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
            <button class="assist-one" :disabled="busy || !selections[field.id]" @click="manualFill(field)">填入此字段</button>
            <small v-if="results[field.id]" :class="resultTone(results[field.id])">{{ resultDetail(results[field.id]) }}</small>
            <button v-if="results[field.id]?.status === 'failed'" class="assist-one" :disabled="busy" @click="fill(field.id)">重试该字段</button>
            <button v-if="results[field.id]?.status === 'filled' && results[field.id]?.source === 'ai'" class="confirm-match" @click="confirmAiField(field.id)">确认匹配并恢复正常高亮</button>
          </div>
        </template>
      </section>

      <section v-if="polishableFields.length" class="panel-section polish-panel"><h2>AI 润色开放文本</h2><select v-model="selectedPolishField" @change="maxLength = selectedField?.maxLength || 300"><option value="">选择要润色的字段</option><option v-for="field in polishableFields" :key="field.id" :value="field.id">{{ field.label || field.placeholder || field.id }}</option></select><textarea v-model="jobDescription" rows="2" placeholder="岗位要求（可选）"></textarea><div class="panel-action-row"><button :disabled="busy || !selectedPolishField || !aiReady" @click="polish">生成建议</button></div><div v-if="polished" class="suggestion"><textarea v-model="suggestion" rows="5"></textarea><small>{{ suggestion.length }} 字，请核对事实</small><button class="panel-primary" @click="adopt">确认采用</button></div></section>
    </div>
  </main>
  <OptionsApp v-else :key="controlView" embedded :initial-view="controlView" @auto-fill="startAutoFillFromHome" @collapse="openCompactView" @fill-fact="manualFillFact" @deactivated="onLicenseCleared" />
  <div v-if="aiPrompt === 'pending'" class="ai-prompt-mask">
    <div class="ai-prompt" role="dialog" aria-labelledby="ai-prompt-title">
      <h2 id="ai-prompt-title">建议先配置 AI</h2>
      <p>配置 AI 服务后，插件能读懂表单字段的不同说法（如「名字」对应「姓名」）并按填写要求调整内容，识别和填写会更准确。</p>
      <p>不配置也可以立即填写，但只会按字段名精确匹配知识库。</p>
      <div class="ai-prompt-actions">
        <button class="panel-primary" @click="goConfigureAi">去配置</button>
        <button @click="fillWithoutAi">不配置，立即填充</button>
      </div>
    </div>
  </div>
  </template>
</template>

<style scoped>
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

.compact-mode .compact-content { padding: 0 10px 6px; }

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
