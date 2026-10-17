<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { getAiVisionStatus, parseResume, testAiConnection, testAiVision } from '../../application/api'
import { downloadBlob, exportFacts, exportProfileTemplate, importFacts, mergeImportedProfileFacts } from '../../infrastructure/transfer/dataTransfer'
import {
  clearAiSettings, clearAllLocalData, clearCurrentResume, clearProfile, createBackup,
  loadAiSettings, loadCurrentResume, loadProfile, loadResumeLibrary, loadTemplates, restoreBackup,
  saveAiSettings, saveCurrentResume, saveProfile, saveResumeLibrary, saveTemplates
} from '../../infrastructure/storage/store'
import type { AiSettings, BackupPayload, CurrentResume, Fact, LearnedAlias, ResumeTemplate, SiteRule } from '../../domain/types'
import { beginPanelDrag } from '../bridge/panelBridge'
import { mergeFactsByPriority } from '../../features/autofill/factPriority'
import { factToSlot } from '../../features/autofill/match/factToSlot'
import { canonicalGroupName } from '../../features/rag/knowledge'
import { clearRuleLabelScope, importRules, loadSiteRules, removeRule, setRuleDisabled } from '../../features/siteRules/ruleStore'
import { loadLearnedAliases, removeLearnedAlias, setAliasDisabled } from '../../features/ontology/learnedAliases'
import { slotById } from '../../features/ontology/slotRegistry'
import { sectionLabel } from '../../features/ontology/sections'
import type { SectionId } from '../../domain/slots'
import { clearLicense, licenseExpiryLabel, loadLicense, type LicenseRecord } from '../../features/license/license'

type ViewName = 'home' | 'resume' | 'profile' | 'assist' | 'settings'
type FeatureSettings = { autoHighlight: boolean; autoClipboard: boolean; aiMapping: boolean; debugMode: boolean; miniPanel: boolean; aiMatchThreshold: number }
type ProfileSection = { id: string; label: string; group: string; aliases: string[]; repeatable: boolean; fields: string[] }
const LEGACY_FIELD_KEYS: Record<string, string[]> = {
  预计毕业时间: ['毕业时间', '毕业日期', '毕业年月']
}
function samePresetSlot(group: string, left: string, right: string): boolean {
  const slot = factToSlot({ group, key: left, item: 1 }).slot
  return Boolean(slot) && slot === factToSlot({ group, key: right, item: 1 }).slot
}
function factForProfileField(rows: Fact[], key: string): Fact | undefined {
  const exact = rows.find(fact => fact.key === key) || rows.find(fact => LEGACY_FIELD_KEYS[key]?.includes(fact.key))
  if (exact) return exact
  const group = rows[0]?.group || ''
  if (!group) return undefined
  const aliased = rows.filter(fact => samePresetSlot(group, fact.key, key))
  return aliased.find(fact => fact.value.trim()) || aliased[0]
}
function isPresetFieldKey(section: ProfileSection, key: string): boolean {
  if (section.fields.includes(key) || section.fields.some(field => LEGACY_FIELD_KEYS[field]?.includes(key))) return true
  return section.fields.some(field => samePresetSlot(section.group, key, field))
}

const props = withDefaults(defineProps<{ embedded?: boolean; initialView?: ViewName }>(), { embedded: false, initialView: 'home' })
const emit = defineEmits<{ (event: 'auto-fill'): void; (event: 'collapse'): void; (event: 'fill-fact', fact: Fact): void; (event: 'deactivated'): void }>()
const view = ref<ViewName>(props.initialView)
const facts = ref<Fact[]>([])
const currentResume = ref<CurrentResume | null>(null)
const resumes = ref<CurrentResume[]>([])
const selectedFile = ref<File | null>(null)
const aiSettings = reactive<AiSettings>({ url: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini' })
const aiReady = computed(() => Boolean(aiSettings.url.trim() && aiSettings.key.trim() && aiSettings.model.trim()))
const showApiKey = ref(false)
const busy = ref(false)
const message = ref('')
const warning = ref('')
const aiMessage = ref('')
const aiTextStatus = ref<'unknown' | 'testing' | 'ready' | 'failed'>('unknown')
const aiVisionStatus = ref<'unknown' | 'testing' | 'ready' | 'failed'>('unknown')
watch(() => [aiSettings.url, aiSettings.key, aiSettings.model], () => {
  if (aiTextStatus.value !== 'testing') aiTextStatus.value = 'unknown'
  if (aiVisionStatus.value !== 'testing') aiVisionStatus.value = 'unknown'
})
const templates = ref<ResumeTemplate[]>([])
const tableFile = ref<File | null>(null)
const profileTableFile = ref<File | null>(null)
const profileFileInput = ref<HTMLInputElement | null>(null)
const backupFile = ref<File | null>(null)
const redactTable = ref(true)
const redactBackup = ref(true)
const search = ref('')
const selectedProfileSection = ref('personal')
const profileEditing = ref(false)
const profileEditRows = ref<Array<Fact & { custom?: boolean }>>([])
const features = reactive<FeatureSettings>({ autoHighlight: true, autoClipboard: true, aiMapping: true, debugMode: false, miniPanel: true, aiMatchThreshold: 85 })
const siteRules = ref<SiteRule[]>([])
const learnedAliases = ref<LearnedAlias[]>([])
const license = ref<LicenseRecord | null>(null)
const ruleFile = ref<File | null>(null)
const rulesByDomain = computed(() => {
  const groups = new Map<string, SiteRule[]>()
  for (const rule of siteRules.value) {
    if (!groups.has(rule.domain)) groups.set(rule.domain, [])
    groups.get(rule.domain)!.push(rule)
  }
  return [...groups.entries()].map(([domain, rules]) => ({ domain, rules }))
})

const navItems: Array<{ id: ViewName; label: string; icon: string }> = [
  { id: 'home', label: '首页', icon: '⌂' }, { id: 'resume', label: '简历', icon: '▤' },
  { id: 'profile', label: '我的信息', icon: '♙' }, { id: 'assist', label: '辅助填写', icon: '✎' },
  { id: 'settings', label: '设置', icon: '⚙' }
]
const profileSections: ProfileSection[] = [
  { id: 'personal', label: '基本信息 / 个人信息', group: '基本信息', aliases: ['基本信息', '个人信息'], repeatable: false, fields: ['姓名', '证件类型', '证件号码', '性别', '出生日期', '民族', '政治面貌', '籍贯', '健康状况', '高考生源地', '户口所在地', '现居住城市', '就读院校所在城市', '是否为应届毕业生', '预计毕业时间', '是否接受岗位调剂', '移动电话', '电子邮箱', '通信地址', '紧急联系人姓名', '紧急联系方式', '内推码'] },
  { id: 'education', label: '教育经历', group: '教育经历', aliases: ['教育经历', '教育背景'], repeatable: true, fields: ['入学时间', '毕业时间', '学校名称', '学历', '学位', '学制', '受教育类型', '院系', '专业名称', '专业课程'] },
  { id: 'intention', label: '求职意向', group: '求职意向', aliases: ['求职意向'], repeatable: false, fields: ['期望工作地点', '期望薪酬', '到岗时间', '期望工作性质', '了解该招聘信息渠道'] },
  { id: 'project', label: '项目经验', group: '项目经验', aliases: ['项目经验', '项目经历'], repeatable: true, fields: ['开始时间', '结束时间', '项目名称', '项目职务', '项目描述'] },
  { id: 'work', label: '工作经历', group: '工作经历', aliases: ['工作经历', '职业经历', '任职经历'], repeatable: true, fields: ['开始时间', '结束时间', '企业名称', '职位名称', '工作描述'] },
  { id: 'internship', label: '实习经历', group: '实习经历', aliases: ['实习经历'], repeatable: true, fields: ['开始时间', '结束时间', '企业名称', '职位名称', '证明人姓名', '证明人职务', '证明人联系方式', '工作描述'] },
  { id: 'campus', label: '社会实践 / 校内活动', group: '社会实践 / 校内活动', aliases: ['社会实践 / 校内活动', '社会实践', '校内活动'], repeatable: true, fields: ['开始时间', '结束时间', '活动名称', '活动描述', '职务'] },
  { id: 'awards', label: '在校获奖荣誉', group: '在校获奖荣誉', aliases: ['在校获奖荣誉', '奖励荣誉', '荣誉奖励', '获奖'], repeatable: true, fields: ['奖项类别', '奖励名称', '奖励级别', '奖励等级', '获奖时间', '颁发单位'] },
  { id: 'certificates', label: '证书', group: '证书', aliases: ['证书', '资格证书', '技能证书'], repeatable: true, fields: ['证书名称', '证书等级', '获得时间', '发证机构', '证书编号'] },
  { id: 'skills', label: '技能 / 爱好', group: '技能 / 爱好', aliases: ['技能 / 爱好', '技能', '个人爱好'], repeatable: false, fields: ['英语水平', '英语成绩得分', '个人爱好'] },
  { id: 'family', label: '家庭关系', group: '家庭关系', aliases: ['家庭关系'], repeatable: true, fields: ['姓名', '关系', '工作单位'] },
  { id: 'self', label: '自我评价', group: '自我评价', aliases: ['自我评价', '开放文本'], repeatable: false, fields: ['评价内容'] }
]
const activeProfileSection = computed(() => profileSections.find(section => section.id === selectedProfileSection.value) || profileSections[0])
const activeProfileItems = computed(() => {
  const section = activeProfileSection.value
  const matching = facts.value.filter(fact => section.aliases.includes(fact.group))
  const itemNumbers = section.repeatable
    ? [...new Set([1, ...matching.map(fact => Math.max(1, fact.item || 1))])].sort((a, b) => a - b)
    : [1]
  return itemNumbers.map(item => {
    const itemFacts = matching.filter(fact => !section.repeatable || (fact.item || 1) === item)
    const presetRows = section.fields.map(key => ({ key, fact: factForProfileField(itemFacts, key) }))
    const customRows = itemFacts.filter(fact => !isPresetFieldKey(section, fact.key)).map(fact => ({ key: fact.key, fact }))
    return { item, rows: [...presetRows, ...customRows] }
  })
})
const profileEditItems = computed(() => {
  const items = [...new Set(profileEditRows.value.map(row => Math.max(1, row.item || 1)))].sort((a, b) => a - b)
  return items.map(item => ({ item, rows: profileEditRows.value.filter(row => (row.item || 1) === item) }))
})
const centerFacts = computed(() => {
  const seen = new Set<string>()
  // 辅助填写只展示知识库（我的信息），简历识别结果需先保存入库
  return mergeFactsByPriority(facts.value).filter(fact => {
    if (!fact.value.trim()) return false
    const identity = `${fact.group}|${fact.item || 1}|${fact.key}|${fact.value}`.toLowerCase()
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
})
function sectionForFactGroup(group: string): ProfileSection | undefined {
  const value = group.trim()
  const matches = (section: ProfileSection, name: string) =>
    section.label === name || section.group === name || section.aliases.some(alias => alias.toLowerCase() === name.toLowerCase())
  const direct = profileSections.find(section => matches(section, value))
  if (direct) return direct
  return profileSections.find(section => matches(section, canonicalProfileGroup(value)))
}

const assistGroups = computed(() => {
  const term = search.value.trim().toLowerCase()
  return profileSections.map(section => {
    const matching = centerFacts.value.filter(fact => sectionForFactGroup(fact.group)?.id === section.id)
    const itemNumbers = [...new Set(matching.map(fact => Math.max(1, fact.item || 1)))].sort((a, b) => a - b)
    const items = itemNumbers.map(item => {
      const itemFacts = matching.filter(fact => Math.max(1, fact.item || 1) === item)
      const preset = section.fields.flatMap(key => {
        const fact = factForProfileField(itemFacts, key)
        return fact ? [fact] : []
      })
      const custom = itemFacts.filter(fact => !isPresetFieldKey(section, fact.key))
      const rows = [...preset, ...custom].filter(fact => !term || `${fact.key} ${fact.value}`.toLowerCase().includes(term))
      return { item, rows }
    }).filter(entry => entry.rows.length > 0)
    return { id: section.id, label: section.label, items, count: items.reduce((sum, entry) => sum + entry.rows.length, 0) }
  })
})
const selectedAssistGroup = ref('')
const activeAssistGroup = computed(() => assistGroups.value.find(group => group.id === selectedAssistGroup.value) || assistGroups.value[0] || null)
const completeness = computed(() => {
  if (!facts.value.length) return 0
  const important = ['姓名', '邮箱', '手机', '电话', '城市', '学校', '学历', '专业', '公司', '职位', '技能']
  const hit = important.filter(key => facts.value.some(fact => fact.key.includes(key) && fact.value.trim())).length
  return Math.min(100, Math.round((hit / important.length) * 100))
})
const resumeDate = computed(() => currentResume.value?.parsedAt ? new Date(currentResume.value.parsedAt).toLocaleString('zh-CN', { hour12: false }) : '')

onMounted(async () => {
  facts.value = (await loadProfile()).facts
  currentResume.value = await loadCurrentResume()
  resumes.value = await loadResumeLibrary()
  if (currentResume.value && !resumes.value.some(item => item.id === currentResume.value?.id)) {
    resumes.value = [currentResume.value, ...resumes.value]
    await saveResumeLibrary(resumes.value)
  }
  Object.assign(aiSettings, await loadAiSettings())
  const savedVision = await getAiVisionStatus(aiSettings)
  aiVisionStatus.value = savedVision.status
  templates.value = await loadTemplates()
  const stored = await chrome.storage.local.get('featureSettingsV1')
  if (stored.featureSettingsV1) Object.assign(features, stored.featureSettingsV1)
  features.aiMatchThreshold = Math.min(100, Math.max(0, Number(features.aiMatchThreshold) || 85))
  siteRules.value = await loadSiteRules()
  learnedAliases.value = await loadLearnedAliases()
  license.value = await loadLicense()
  if (!props.embedded) {
    const requested = new URLSearchParams(location.search).get('view') as ViewName | null
    if (requested && navItems.some(item => item.id === requested)) view.value = requested
  }
})

function go(next: ViewName) {
  view.value = next
  // 进行中的任务（如简历识别）提示要跨页面保留，完成态的提示在离开页面时清除
  if (!busy.value) message.value = ''
  if (!props.embedded) history.replaceState(null, '', `${location.pathname}?view=${next}`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function dragFromHeader(event: PointerEvent) {
  if (!props.embedded || (event.target as HTMLElement).closest('button, input, a')) return
  event.preventDefault()
  beginPanelDrag(event.clientX, event.clientY)
}
function handleResumeDrop(event: DragEvent) {
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) { message.value = '仅支持 PDF、DOCX、TXT 格式。'; return }
  selectedFile.value = file
}
async function saveFeatureSettings() {
  features.aiMatchThreshold = Math.min(100, Math.max(0, Number(features.aiMatchThreshold) || 0))
  await chrome.storage.local.set({ featureSettingsV1: { ...features } })
}

async function deactivateLicense() {
  if (!confirm('清除后需要重新输入激活码才能使用插件。')) return
  await clearLicense()
  license.value = null
  emit('deactivated')
}

// ─── 站点规则管理（F26/F27）─────────────────────────────────
function ruleSlotName(slot: string): string {
  const def = slotById(slot)
  return def ? `${sectionLabel(def.section)} · ${def.aliases[0]}` : slot
}
function ruleSectionName(sectionId?: string): string {
  return sectionId ? sectionLabel(sectionId as SectionId) : ''
}
async function toggleRule(rule: SiteRule) {
  await setRuleDisabled(rule.id, !rule.disabled)
  siteRules.value = await loadSiteRules()
}
async function deleteRule(rule: SiteRule) {
  await removeRule(rule.id)
  siteRules.value = await loadSiteRules()
  message.value = '站点规则已删除。'
}
async function limitRuleToFingerprint(rule: SiteRule) {
  await clearRuleLabelScope(rule.id)
  siteRules.value = await loadSiteRules()
  message.value = '这条规则现在只匹配原来的那一个字段。'
}
async function toggleAlias(alias: LearnedAlias) {
  await setAliasDisabled(alias.alias, alias.sectionId, !alias.disabled)
  learnedAliases.value = await loadLearnedAliases()
  message.value = alias.disabled ? '这条字段别名已重新启用。' : '这条字段别名已停用。'
}
async function deleteAlias(alias: LearnedAlias) {
  await removeLearnedAlias(alias.alias, alias.sectionId)
  learnedAliases.value = await loadLearnedAliases()
  message.value = '已删除这条字段别名。'
}
async function exportRules() {
  const payload = JSON.stringify(siteRules.value, null, 2)
  downloadBlob(new Blob([payload], { type: 'application/json;charset=utf-8' }), `Resume-Autofill-rules-${new Date().toISOString().slice(0, 10)}.json`)
  message.value = '站点规则已导出（不含个人数据）。'
}
async function importRuleFile() {
  if (!ruleFile.value) return
  try {
    const added = await importRules(JSON.parse(await ruleFile.value.text()))
    siteRules.value = await loadSiteRules()
    message.value = `已导入 ${added} 条站点规则。`
    ruleFile.value = null
  } catch (error) {
    message.value = error instanceof Error ? error.message : '规则包导入失败。'
  }
}
async function saveAiConfig() {
  if (!aiSettings.url.trim() || !aiSettings.key.trim() || !aiSettings.model.trim()) { aiMessage.value = '请完整填写 API Base URL、API Key 和模型。'; return }
  if (!/^https?:\/\//i.test(aiSettings.url.trim())) { aiMessage.value = 'API Base URL 必须以 http:// 或 https:// 开头。'; return }
  await saveAiSettings(aiSettings); aiMessage.value = 'AI 配置已安全保存到当前浏览器。'
}
async function verifyAiConfig() {
  if (!aiReady.value) { aiMessage.value = '请先完整填写 AI 配置。'; return }
  busy.value = true; aiTextStatus.value = 'testing'; aiMessage.value = '正在测试文本接口…'
  try { const reply = await testAiConnection(aiSettings); aiTextStatus.value = 'ready'; aiMessage.value = `文本接口正常：${reply.slice(0, 70)}` }
  catch (error) { aiTextStatus.value = 'failed'; aiMessage.value = error instanceof Error ? error.message : 'AI 接口连接失败。' }
  finally { busy.value = false }
}
function visualTestImage(): { imageUrl: string; token: string } {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  const token = `HT-${Array.from(bytes, value => alphabet[value % alphabet.length]).join('')}`
  const canvas = document.createElement('canvas')
  canvas.width = 440
  canvas.height = 150
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法生成视觉测试图片。')
  context.fillStyle = '#f8fafc'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#2563eb'
  context.lineWidth = 4
  context.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
  context.fillStyle = '#0f172a'
  context.font = 'bold 44px monospace'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(token, canvas.width / 2, canvas.height / 2)
  return { imageUrl: canvas.toDataURL('image/png'), token }
}
async function verifyAiVision() {
  if (!aiReady.value) { aiMessage.value = '请先完整填写 AI 配置。'; return }
  busy.value = true; aiVisionStatus.value = 'testing'; aiMessage.value = '正在发送内置随机图片测试…'
  try {
    const sample = visualTestImage()
    const reply = await testAiVision(aiSettings, sample.imageUrl, sample.token)
    aiVisionStatus.value = 'ready'
    aiMessage.value = `视觉模型正常：${reply}`
  } catch (error) {
    aiVisionStatus.value = 'failed'
    aiMessage.value = error instanceof Error ? error.message : '视觉图片测试失败。'
  } finally { busy.value = false }
}
async function removeAiConfig() {
  if (!confirm('确定删除当前浏览器中保存的 AI 配置吗？')) return
  await clearAiSettings(); Object.assign(aiSettings, { url: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini' })
  aiTextStatus.value = 'unknown'; aiVisionStatus.value = 'unknown'
  aiMessage.value = 'AI 配置已删除。'
}
function selectProfileSection(sectionId: string) {
  selectedProfileSection.value = sectionId
  profileEditing.value = false
  profileEditRows.value = []
}
function beginProfileEdit() {
  const section = activeProfileSection.value
  profileEditRows.value = activeProfileItems.value.flatMap(entry => entry.rows.map(row => ({
    id: row.fact?.id || crypto.randomUUID(),
    group: section.group,
    item: entry.item,
    key: row.key,
    value: row.fact?.value || '',
    evidence: row.fact?.evidence || '用户编辑',
    source: 'profile' as const,
    updatedAt: row.fact?.updatedAt,
    custom: !isPresetFieldKey(section, row.key)
  })))
  profileEditing.value = true
}
function addProfileSectionItem() {
  if (!profileEditing.value) beginProfileEdit()
  const section = activeProfileSection.value
  const item = section.repeatable ? Math.max(0, ...profileEditRows.value.map(row => row.item || 1)) + 1 : 1
  profileEditRows.value.push(...section.fields.map(key => ({
    id: crypto.randomUUID(), group: section.group, item, key, value: '', evidence: '用户编辑', source: 'profile' as const, custom: false
  })))
}
function addCustomProfileField(item: number) {
  profileEditRows.value.push({
    id: crypto.randomUUID(), group: activeProfileSection.value.group, item, key: '', value: '', evidence: '用户自定义字段', source: 'profile', custom: true
  })
}
function removeProfileSectionItem(item: number) {
  const section = activeProfileSection.value
  const target = Math.max(1, item || 1)
  const remaining = profileEditRows.value.filter(row => Math.max(1, row.item || 1) !== target)
  if (!remaining.length) {
    profileEditRows.value = section.fields.map(key => ({
      id: crypto.randomUUID(), group: section.group, item: 1, key, value: '', evidence: '用户编辑', source: 'profile' as const, custom: false
    }))
    return
  }
  const items = [...new Set(remaining.map(row => Math.max(1, row.item || 1)))].sort((a, b) => a - b)
  const remap = new Map(items.map((old, index) => [old, index + 1]))
  profileEditRows.value = remaining.map(row => ({ ...row, item: remap.get(Math.max(1, row.item || 1)) || 1 }))
}
function removeProfileEditRow(id: string) {
  profileEditRows.value = profileEditRows.value.filter(row => row.id !== id)
}
function cancelProfileEdit() {
  profileEditing.value = false
  profileEditRows.value = []
}
async function saveProfileEdit() {
  const section = activeProfileSection.value
  const outsideSection = facts.value.filter(fact => !section.aliases.includes(fact.group))
  const edited = profileEditRows.value.filter(row => row.key.trim()).map(row => ({
    id: row.id || crypto.randomUUID(), group: section.group, item: Math.max(1, row.item || 1), key: row.key.trim(), value: row.value,
    evidence: row.evidence || '用户编辑', source: 'profile' as const, updatedAt: new Date().toISOString()
  }))
  facts.value = [...outsideSection, ...edited]
  await saveProfile(facts.value)
  profileEditing.value = false
  profileEditRows.value = []
  message.value = `${section.label}已保存，空字段也已保留。`
}
function clean(rows: Fact[]): Fact[] {
  return rows.filter(row => row.key.trim() && row.value.trim()).map(row => ({
    ...row, id: row.id || crypto.randomUUID(), group: row.group.trim() || '其他', item: Math.max(1, Number(row.item) || 1),
    key: row.key.trim(), value: row.value.trim(), evidence: row.evidence || '手动录入', updatedAt: new Date().toISOString()
  }))
}

function profileTemplateRows(): Fact[] {
  return profileSections.flatMap(section => {
    const sectionFacts = facts.value.filter(fact => section.aliases.includes(fact.group))
    const itemNumbers = section.repeatable
      ? [...new Set([1, ...sectionFacts.map(fact => Math.max(1, fact.item || 1))])].sort((a, b) => a - b)
      : [1]
    return itemNumbers.flatMap(item => {
      const itemFacts = sectionFacts.filter(fact => !section.repeatable || Math.max(1, fact.item || 1) === item)
      const preset = section.fields.map(key => {
        const found = factForProfileField(itemFacts, key)
        return found ? { ...found, key } : {
          id: crypto.randomUUID(), group: section.group, item, key, value: '', evidence: '', source: 'profile' as const
        }
      })
      const custom = itemFacts.filter(fact => !isPresetFieldKey(section, fact.key))
      return [...preset, ...custom].map(fact => ({ ...fact, group: section.group, item }))
    })
  })
}

async function downloadProfileTemplate() {
  busy.value = true
  try {
    const rows = profileTemplateRows()
    const filename = `我的信息-${new Date().toISOString().slice(0, 10)}.xlsx`
    downloadBlob(await exportProfileTemplate(rows), filename)
    const filled = rows.filter(row => row.value.trim()).length
    const custom = rows.filter(row => row.value.trim() && !profileSections.some(section => section.group === row.group && section.fields.includes(row.key))).length
    message.value = `已导出 ${filled} 个已填写字段（含 ${custom} 个自定义字段），未填写的模板字段保持留空。`
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Excel 模板下载失败。'
  } finally {
    busy.value = false
  }
}

function assignProfileTableFile(file: File | null) {
  if (file && !/\.(xlsx|xls|csv)$/i.test(file.name)) { message.value = '仅支持 XLSX、XLS 或 CSV 表格。'; return }
  profileTableFile.value = file
  message.value = file ? `已选择：${file.name}` : ''
}

function selectProfileTableFile(event: Event) {
  assignProfileTableFile((event.target as HTMLInputElement).files?.[0] || null)
}

function handleProfileTableDrop(event: DragEvent) {
  assignProfileTableFile(event.dataTransfer?.files?.[0] || null)
}

function canonicalProfileGroup(group: string): string {
  const byAlias = profileSections.find(section => section.aliases.some(alias => alias.toLowerCase() === group.trim().toLowerCase()))?.group
  // 别名未命中时走知识库统一归一（可识别工作表名如「社会实践 · 校内活动」「教育背景」等变体）
  return byAlias || canonicalGroupName(group)
}

async function importProfileTable() {
  if (!profileTableFile.value) return
  busy.value = true
  try {
    const imported = (await importFacts(profileTableFile.value)).map(fact => ({
      ...fact,
      group: canonicalProfileGroup(fact.group),
      source: 'profile' as const
    }))
    const result = mergeImportedProfileFacts(facts.value, imported)
    facts.value = result.facts
    await saveProfile(facts.value)
    profileEditing.value = false
    profileEditRows.value = []
    message.value = `导入完成：更新 ${result.updated} 项，新增 ${result.added} 项；其他信息保持不变。`
    profileTableFile.value = null
    if (profileFileInput.value) profileFileInput.value.value = ''
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Excel 表格导入失败。'
  } finally {
    busy.value = false
  }
}
async function importFile() {
  if (!selectedFile.value) { message.value = '请先选择 PDF、DOCX 或 TXT 简历。'; return }
  if (selectedFile.value.size > 10 * 1024 * 1024) { message.value = '文件不能超过 10MB。'; return }
  if (!aiReady.value) { message.value = '请先在「设置」中配置 AI（API URL、API Key、模型），简历识别需要 AI 按模板字段提取。'; return }
  if (!confirm(`将把“${selectedFile.value.name}”提取出的文字发送到你配置的 AI 服务进行识别，是否继续？`)) return
  busy.value = true; message.value = '正在让 AI 按模板字段填写表格，请稍候…'; warning.value = ''
  try {
    const result = await parseResume(selectedFile.value, true, aiSettings)
    const importedResume: CurrentResume = { id: crypto.randomUUID(), fileName: result.fileName, fileType: result.fileType, extractedText: result.text, facts: [], parsedAt: new Date().toISOString() }
    currentResume.value = importedResume
    await saveCurrentResume(importedResume)
    resumes.value = [importedResume, ...resumes.value.filter(item => item.fileName !== importedResume.fileName)].slice(0, 30)
    await saveResumeLibrary(resumes.value)
    const baseName = selectedFile.value.name.replace(/\.(pdf|docx|txt)$/i, '')
    downloadBlob(result.workbook, `${baseName}-识别结果.xlsx`)
    warning.value = result.warning || ''
    const filled = result.facts.filter(fact => fact.value.trim()).length
    message.value = `识别完成，模板中 ${filled} 个字段已填写（其余留空），Excel 已下载。请打开核对后，到「我的信息」导入知识库。`
  } catch (error) { message.value = error instanceof Error ? error.message : '简历解析失败。' }
  finally { busy.value = false }
}
async function clearResumeOnly() {
  if (!confirm('确定移除当前简历吗？个人信息档案不会被删除。')) return
  const removedId = currentResume.value?.id
  await clearCurrentResume(); currentResume.value = null; resumes.value = resumes.value.filter(item => item.id !== removedId); await saveResumeLibrary(resumes.value)
  selectedFile.value = null; message.value = '当前简历已移除。'
}
async function setCurrentResume(resume: CurrentResume) { currentResume.value = resume; await saveCurrentResume(resume); message.value = `已将“${resume.fileName}”设为当前简历。` }
async function removeResume(resume: CurrentResume) {
  if (!confirm(`确定删除“${resume.fileName}”吗？`)) return
  resumes.value = resumes.value.filter(item => item.id !== resume.id); await saveResumeLibrary(resumes.value)
  if (currentResume.value?.id === resume.id) { currentResume.value = resumes.value[0] || null; if (currentResume.value) await saveCurrentResume(currentResume.value); else await clearCurrentResume() }
  message.value = '简历已删除。'
}
async function clearProfileOnly() {
  if (!confirm('确定删除全部个人信息吗？')) return
  await clearProfile(); facts.value = []; profileEditing.value = false; profileEditRows.value = []; message.value = '个人信息已删除。'
}
async function clearAll() {
  if (!confirm('确定清理插件中的简历、个人信息、模板和 AI 配置吗？此操作不可恢复。')) return
  await clearAllLocalData(); facts.value = []; templates.value = []; resumes.value = []; currentResume.value = null; siteRules.value = []; learnedAliases.value = []
  Object.assign(aiSettings, { url: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini' }); message.value = '全部本地数据已清理。'
}
async function createTemplate() {
  const name = prompt('请输入简历模板名称：')?.trim(); if (!name || !currentResume.value?.facts.length) return
  const now = new Date().toISOString()
  templates.value = [{ id: crypto.randomUUID(), name, description: '', facts: clean(currentResume.value.facts).map(fact => ({ ...fact, source: 'resume' })), createdAt: now, updatedAt: now }, ...templates.value]
  await saveTemplates(templates.value); message.value = `模板“${name}”已保存。`
}
async function applyTemplate(template: ResumeTemplate) {
  if (!currentResume.value) { message.value = '请先上传并选择一份简历，再应用字段模板。'; return }
  currentResume.value = { ...currentResume.value, facts: template.facts.map(fact => ({ ...fact, id: crypto.randomUUID(), source: 'resume' })) }
  await saveCurrentResume(currentResume.value)
  resumes.value = [currentResume.value, ...resumes.value.filter(item => item.id !== currentResume.value?.id)].slice(0, 30)
  await saveResumeLibrary(resumes.value)
  message.value = `已将模板“${template.name}”应用到当前简历；“我的信息”未被修改。`
}
async function removeTemplate(template: ResumeTemplate) {
  if (!confirm(`确定删除模板“${template.name}”吗？`)) return
  templates.value = templates.value.filter(item => item.id !== template.id); await saveTemplates(templates.value); message.value = '模板已删除。'
}
async function copyFact(fact: Fact) {
  try { await navigator.clipboard.writeText(fact.value); message.value = `“${fact.key}”已复制，可回到网申页面粘贴。` }
  catch { message.value = '复制失败，请检查浏览器剪贴板权限。' }
}
async function useCenterFact(fact: Fact) {
  if (props.embedded) emit('fill-fact', { ...fact, source: fact.source || (currentResume.value?.facts.some(item => item.id === fact.id) ? 'resume' : 'profile') })
  else await copyFact(fact)
}
async function exportTable(format: 'xlsx' | 'csv') {
  downloadBlob(await exportFacts(clean(facts.value), format, redactTable.value), `Resume-Autofill-${new Date().toISOString().slice(0, 10)}.${format}`)
  message.value = redactTable.value ? '档案已脱敏导出。' : '档案已导出，请妥善保管。'
}
async function importTable() {
  if (!tableFile.value) return
  busy.value = true
  try { const imported = await importFacts(tableFile.value); facts.value = [...facts.value, ...clean(imported)]; await saveProfile(facts.value); message.value = `已导入 ${imported.length} 条信息。` }
  catch (error) { message.value = error instanceof Error ? error.message : '表格导入失败。' }
  finally { busy.value = false }
}
async function exportBackup() {
  const backup = await createBackup(redactBackup.value)
  downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }), `Resume-Autofill-backup-${new Date().toISOString().slice(0, 10)}.json`)
  message.value = '备份已导出。'
}
async function importBackup() {
  if (!backupFile.value) return
  busy.value = true
  try {
    const payload = JSON.parse(await backupFile.value.text()) as BackupPayload; await restoreBackup(payload)
    facts.value = (await loadProfile()).facts; currentResume.value = await loadCurrentResume(); resumes.value = await loadResumeLibrary(); templates.value = await loadTemplates(); Object.assign(aiSettings, await loadAiSettings()); siteRules.value = await loadSiteRules(); learnedAliases.value = await loadLearnedAliases(); message.value = '备份已恢复。'
  } catch (error) { message.value = error instanceof Error ? error.message : '备份恢复失败。' }
  finally { busy.value = false }
}
</script>

<template>
  <main class="app-shell relative mx-auto min-h-screen w-full max-w-[520px] border border-brand-line/80 bg-white/95 px-3 pb-[18px] text-brand-navy shadow-[0_18px_55px_rgba(41,74,120,.18)]" :class="{ embedded: props.embedded }">
    <header class="app-header draggable-header flex h-[70px] items-center gap-2" @pointerdown="dragFromHeader">
      <span class="header-drag-handle" title="按住拖动面板" aria-hidden="true"></span>
      <button class="brand mr-auto flex min-w-0 items-center gap-2.5 border-0 bg-transparent p-0 text-left" aria-label="回到首页" @click="go('home')"><img class="size-12 rounded-[11px] object-cover" src="/assets/ui/brand-cover.png" alt="鸿途网申助手品牌图" /><span class="grid min-w-0 gap-0.5"><strong class="whitespace-nowrap text-[19px] leading-tight tracking-[-.35px]">鸿途网申助手</strong><small class="whitespace-nowrap text-[9px] text-brand-muted">让求职申请更简单 · AI 为你自动填写</small></span></button>
      <div class="site-chip qq-community flex h-[34px] items-center gap-1.5 rounded-[9px] border border-brand-line bg-white px-[9px] text-[10px] font-bold" data-tooltip="372728248" tabindex="0" role="note" aria-label="欢迎加入 QQ 交流群，群号 372728248"><span class="site-logo">Q</span><span>欢迎加入QQ交流群</span></div><button class="icon-button border-0 bg-transparent p-1 text-xl" :aria-label="props.embedded ? '缩小悬浮面板' : '更多选项'" @click="props.embedded && emit('collapse')">{{ props.embedded ? '−' : '⋮' }}</button>
    </header>
    <nav class="main-nav grid h-[60px] grid-cols-5 overflow-hidden rounded-[11px] border border-brand-line/70 bg-white shadow-[0_5px_16px_rgba(51,92,147,.04)]" aria-label="主要页面"><button v-for="item in navItems" :key="item.id" class="relative grid place-content-center place-items-center gap-0.5 border-0 bg-transparent text-[10px] text-[#546587]" :class="{ active: view === item.id }" @click="go(item.id)"><span class="text-[19px] leading-none">{{ item.icon }}</span><b class="font-semibold">{{ item.label }}</b></button></nav>
    <div v-if="message" class="toast" role="status"><span :class="{ spinning: busy }">{{ busy ? '↻' : '✓' }}</span>{{ message }}<button @click="message = ''">×</button></div>

    <template v-if="view === 'home'">
      <section class="home-hero-card">
        <div class="home-hero-copy">
          <p class="home-hello">你好，欢迎回来！</p>
          <h1>让 AI 帮你高效完成网申</h1>
          <p>智能整理简历信息，自动匹配字段，少打字，多机会。</p>
          <button class="home-start-button" @click="emit('auto-fill')"><span>▶</span><b>开始自动填写</b><i>→</i></button>
          <small>ϟ {{ props.embedded ? 'AI 先分析本页表单字段，再按「我的信息」知识库匹配填写' : '请先在目标网申页面点击扩展图标' }}</small>
        </div>
        <img src="/assets/ui/home-welcome.png" alt="AI 帮助完成网申" />
      </section>

      <section class="home-benefits" aria-label="核心能力">
        <article class="home-benefit violet-card"><img src="/assets/ui/home-ai-recognition.png" alt="" /><div><b>AI 智能识别</b><p>智能分析页面表单<br />识别字段类型</p></div><span>→</span></article>
        <article class="home-benefit green-card"><img src="/assets/ui/home-auto-fill.png" alt="" /><div><b>一键自动填写</b><p>基于个人信息<br />智能匹配填写</p></div><span>→</span></article>
        <article class="home-benefit orange-card"><img src="/assets/ui/home-sites.png" alt="" /><div><b>支持主流招聘网站</b><p>覆盖各大招聘平台<br />快速填写</p></div><span>→</span></article>
      </section>

      <div class="home-primary-grid">
        <section class="home-resume-card">
          <div class="home-card-heading"><img src="/assets/ui/home-pdf.png" alt="" /><div><b>{{ currentResume ? '当前匹配简历' : '尚未上传简历' }}</b><p>{{ currentResume?.fileName || '上传简历，AI 帮你解析并提取关键信息' }}</p><small>支持 PDF、DOCX、TXT</small></div></div>
          <button class="home-upload-zone" @click="go('resume')"><span>⇧</span><b>{{ currentResume ? '管理我的简历' : '点击上传简历' }}</b><small>{{ currentResume ? `${currentResume.facts.length} 条信息 · ${resumeDate}` : '或拖拽文件到简历页面' }}</small><i>→</i></button>
        </section>

        <section class="home-profile-card">
          <div class="home-profile-summary"><img src="/assets/ui/home-avatar.png" alt="个人信息头像" /><div><small>个人信息（优先级最高）</small><b>{{ facts.find(f => /姓名/.test(f.key))?.value || '等待完善' }}</b><p>{{ facts.find(f => /邮箱|email/i.test(f.key))?.value || '添加邮箱、电话、地址等信息' }}</p></div><button @click="go('profile')">✎　编辑</button></div>
          <button class="home-tip-box" @click="go('profile')"><img src="/assets/ui/home-tip.png" alt="" /><span><b>小贴士</b><p>先完善个人信息并上传简历。填写复杂申请表时，打开目标页面后点击浏览器工具栏中的插件图标。</p></span></button>
        </section>
      </div>

      <section class="home-stats-card">
        <div class="home-stats-heading"><div><img src="/assets/ui/overview-document.png" alt="" /><span><b>填写数据概览</b><small>基于你的简历和个人信息</small></span></div><button @click="go('resume')">管理我的简历　→</button></div>
        <div class="stats-grid"><div><img class="stat-illustration" src="/assets/ui/overview-document.png" alt="信息字段" /><strong>{{ facts.length }}</strong><small>手动信息字段</small></div><div class="success"><img class="stat-illustration" src="/assets/ui/overview-check.png" alt="当前简历字段" /><strong>{{ currentResume ? currentResume.facts.length : 0 }}</strong><small>当前简历字段</small></div><div class="danger-stat"><img class="stat-illustration" src="/assets/ui/overview-alert.png" alt="待补充" /><strong>{{ Math.max(0, 12 - Math.min(12, facts.length)) }}</strong><small>待补充</small></div><div class="purple"><span class="completion-ring"><img src="/assets/ui/overview-ring.png" alt="资料完整度" /><b>{{ completeness }}%</b></span><strong>资料完整度</strong><small>继续完善，通过率更高</small></div></div>
      </section>
    </template>

    <template v-else-if="view === 'resume'">
      <section class="hero hero-resume relative mx-1 mb-2.5 flex min-h-[142px] items-center overflow-hidden rounded-xl border border-[#e3eef9] bg-gradient-to-br from-[#effcff] via-[#e5f8ff] to-[#d7f7f2] px-[18px] py-[21px]"><div class="relative z-[2] max-w-[62%]"><h1>上传简历，AI 智能识别</h1><p>支持 PDF、DOCX、TXT 格式，提取关键信息用于网申。</p></div><img class="hero-illustration pointer-events-none absolute right-[-10px] bottom-[-25px] z-[1] h-[168px] w-[210px] object-contain object-bottom drop-shadow-[0_9px_16px_rgba(80,110,189,.12)] select-none" src="/assets/ui/resume-hero.png" alt="上传简历插画" /></section>
      <section class="upload-card"><label class="drop-zone" @dragover.prevent @drop.prevent="handleResumeDrop"><input type="file" accept=".pdf,.docx,.txt" @change="selectedFile = ($event.target as HTMLInputElement).files?.[0] || null" /><span class="upload-cloud">☁</span><b>拖拽文件到此处或点击选择</b><small>支持 PDF、DOCX、TXT，单个文件最大 10MB</small><em>{{ selectedFile?.name || '选择文件' }}</em></label><p class="upload-hint">AI 会按「我的信息」的模板字段从简历中提取内容，生成填好的 Excel。请打开核对后，到「我的信息」导入知识库。</p><button class="gradient-button" :disabled="busy || !selectedFile" @click="importFile">✦ {{ busy ? '正在识别…' : 'AI 识别简历并生成表格' }}</button></section>
      <div v-if="warning" class="inline-notice warning">{{ warning }}</div>
      <section class="content-card"><div class="card-heading"><div><h2>当前匹配简历</h2><p>用于后续分析与填写；与“我的信息”冲突时，以“我的信息”为准。</p></div><button class="subtle-button" @click="createTemplate">保存为模板</button></div><div v-if="currentResume" class="resume-row"><span class="file-badge">{{ currentResume.fileType.toUpperCase() }}</span><div><b>{{ currentResume.fileName }}</b><span>{{ currentResume.facts.length }} 条信息 · {{ resumeDate }}</span></div><span class="current-pill">✓ 当前使用</span><button class="danger-link" @click="clearResumeOnly">移除</button></div><div v-else class="empty-state">还没有简历，请先上传文件。</div></section>
      <section v-if="resumes.length" class="content-card"><div class="card-heading"><h2>简历管理（{{ resumes.length }}）</h2></div><div class="template-list"><div v-for="resume in resumes" :key="resume.id" class="resume-row"><span class="file-badge">{{ resume.fileType.toUpperCase() }}</span><div><b>{{ resume.fileName }}</b><span>{{ resume.facts.length }} 条信息 · {{ new Date(resume.parsedAt).toLocaleDateString('zh-CN') }}</span></div><span v-if="currentResume?.id === resume.id" class="current-pill">当前使用</span><button v-else class="subtle-button" @click="setCurrentResume(resume)">设为当前</button><button class="danger-link" @click="removeResume(resume)">删除</button></div></div></section>
      <section v-if="templates.length" class="content-card"><div class="card-heading"><h2>信息模板（{{ templates.length }}）</h2></div><div class="template-list"><div v-for="template in templates" :key="template.id" class="resume-row"><span class="round-icon">▤</span><div><b>{{ template.name }}</b><span>{{ template.facts.length }} 条信息</span></div><button class="subtle-button" @click="applyTemplate(template)">应用信息</button><button class="danger-link" @click="removeTemplate(template)">删除</button></div></div></section>
    </template>

    <template v-else-if="view === 'profile'">
      <section class="hero hero-profile relative mx-1 mb-2.5 flex min-h-[142px] items-center overflow-hidden rounded-xl border border-[#e3eef9] bg-gradient-to-br from-[#effcff] via-[#e5f8ff] to-[#d7f7f2] px-[18px] py-[21px]"><div class="relative z-[2] max-w-[54%]"><h1>{{ facts.find(f => /姓名/.test(f.key))?.value || '我的信息' }} <small>● 已启用</small></h1><p>求职路上，AI 与你一起前进！</p><small>你的资料仅保存在本地设备</small></div><img class="hero-illustration pointer-events-none absolute right-[-9px] bottom-[-24px] z-[1] h-[168px] w-[218px] object-contain object-bottom drop-shadow-[0_9px_16px_rgba(80,110,189,.12)] select-none" src="/assets/ui/profile-hero.png" alt="个人信息插画" /></section>
      <section class="profile-excel-card" @dragover.prevent @drop.prevent="handleProfileTableDrop">
        <div><b>Excel 批量维护</b><small>模板按板块分工作表，包含全部预设字段和已填内容；可在任意板块表末尾新增行添加自定义字段。</small><span class="drop-hint">⤓ 填好的表格可直接拖到这张卡片上导入</span></div>
        <div class="profile-excel-actions">
          <button class="subtle-button" :disabled="busy" @click="downloadProfileTemplate">↓ 导出已填写的 Excel</button>
          <label class="file-button">选择 Excel<input ref="profileFileInput" type="file" accept=".xlsx,.xls,.csv" @change="selectProfileTableFile" /></label>
          <button class="primary-button" :disabled="!profileTableFile || busy" @click="importProfileTable">{{ busy && profileTableFile ? '正在导入…' : '导入并填充' }}</button>
        </div>
        <span v-if="profileTableFile">已选择：{{ profileTableFile.name }}</span>
      </section>
      <nav class="profile-section-tabs" aria-label="个人信息板块"><button v-for="section in profileSections" :key="section.id" :class="{ active: selectedProfileSection === section.id }" @click="selectProfileSection(section.id)">{{ section.label }}</button></nav>
      <section class="priority-banner"><span>♛</span><div><b>这些信息优先级最高，会优先用于自动填写</b><small>请确保信息准确完整，以获得更好的申请效果。</small></div><strong>{{ completeness }}%<small>资料完整度</small></strong></section>
      <template v-if="!profileEditing">
        <div class="profile-section-scroll">
        <section v-for="entry in activeProfileItems" :key="`${activeProfileSection.id}-${entry.item}`" class="content-card fact-group">
          <div class="card-heading"><h2>{{ activeProfileSection.label }} <small v-if="activeProfileSection.repeatable">第 {{ entry.item }} 段</small></h2></div>
          <div v-for="row in entry.rows" :key="`${entry.item}-${row.key}`" :class="['profile-row', { missing: !row.fact?.value }]">
            <span class="field-icon">{{ /邮箱/.test(row.key) ? '✉' : /手机|电话|联系方式/.test(row.key) ? '☎' : /地址|城市|地点|生源地|户口/.test(row.key) ? '⌖' : /时间|日期/.test(row.key) ? '◷' : '●' }}</span>
            <span>{{ row.key }}</span><b>{{ row.fact?.value || '未填写' }}</b>
          </div>
        </section>
        </div>
        <div class="bottom-actions"><button class="primary-button" @click="beginProfileEdit">✎ 编辑{{ activeProfileSection.label }}</button><button class="danger-link" @click="clearProfileOnly">清空全部</button></div>
      </template>
      <template v-else>
        <div class="profile-section-scroll">
        <section v-for="entry in profileEditItems" :key="`edit-${activeProfileSection.id}-${entry.item}`" class="content-card fact-group profile-editor">
          <div class="card-heading"><h2>{{ activeProfileSection.label }} <small v-if="activeProfileSection.repeatable">第 {{ entry.item }} 段</small></h2><span class="heading-actions"><button v-if="activeProfileSection.repeatable" class="danger-link" @click="removeProfileSectionItem(entry.item)">删除这段</button><button class="subtle-button" @click="addCustomProfileField(entry.item)">＋ 自定义字段</button></span></div>
          <div v-for="row in entry.rows" :key="row.id" class="profile-edit-row">
            <input v-if="row.custom" v-model="row.key" class="custom-key-input" type="text" placeholder="字段名称（必填）" aria-label="自定义字段名称" />
            <span v-else>{{ row.key }}</span>
            <textarea v-if="/描述|课程|评价/.test(row.key)" v-model="row.value" rows="2" :placeholder="`请输入${row.key}（可留空）`" :aria-label="row.key"></textarea>
            <input v-else v-model="row.value" type="text" :placeholder="`请输入${row.key || '字段内容'}（可留空）`" :aria-label="row.key || '字段内容'" />
            <button v-if="row.custom" class="delete-mini" aria-label="删除自定义字段" @click="removeProfileEditRow(row.id)">×</button>
          </div>
        </section>
        </div>
        <div class="bottom-actions"><button v-if="activeProfileSection.repeatable" class="subtle-button" @click="addProfileSectionItem">＋ 新增一段</button><button class="subtle-button" @click="addCustomProfileField(profileEditItems[0]?.item || 1)">＋ 自定义字段</button><button class="subtle-button" @click="cancelProfileEdit">取消</button><button class="primary-button" @click="saveProfileEdit">保存</button></div>
      </template>
      <section class="tip-card"><span>💡</span><div><b>唯一的知识库</b><p>自动填写只使用这里的内容。简历识别、Excel 导入和网页上手动填写的内容，都要归入这里才生效。</p></div></section>
    </template>

    <template v-else-if="view === 'assist'">
      <section class="hero hero-assist relative mx-1 mb-2.5 flex min-h-[142px] items-center overflow-hidden rounded-xl border border-[#e3eef9] bg-gradient-to-br from-[#effcff] via-[#e5f8ff] to-[#d7f7f2] px-[18px] py-[21px]"><div class="relative z-[2] max-w-[62%]"><h1>中心字段辅助填写</h1><p>AI 简历识别 · 自动分类 · 点击即填</p><small>先选中网页输入框，再点击下方中心字段；内容会自动填入并复制到剪贴板。</small></div><img class="hero-illustration pointer-events-none absolute right-[-7px] bottom-[-20px] z-[1] h-[168px] w-[200px] object-contain object-bottom drop-shadow-[0_9px_16px_rgba(80,110,189,.12)] select-none" src="/assets/ui/assist-hero.png" alt="辅助填写插画" /></section>
      <section class="steps-card"><h2>如何使用辅助填写？</h2><div class="steps"><div><span>1</span><b>打开目标表单</b><small>进入网申填写页面</small></div><i>→</i><div><span>2</span><b>点击扩展图标</b><small>识别网页输入框</small></div><i>→</i><div><span>3</span><b>选择信息填入</b><small>回读并确认结果</small></div></div></section>
      <div class="assist-banner"><span>◎</span><div><b>以下字段全部来自「我的信息」知识库</b><small>简历识别和 Excel 导入的内容需先保存进知识库才会出现在这里。</small></div></div>
      <div class="search-box">⌕<input v-model="search" type="search" placeholder="搜索字段，例如：公司、学校、技能…" /></div>
      <nav class="profile-section-tabs" aria-label="辅助填写分类"><button v-for="group in assistGroups" :key="group.id" type="button" :class="{ active: activeAssistGroup?.id === group.id }" @click="selectedAssistGroup = group.id">{{ group.label }} {{ group.count }}</button></nav>
      <section v-if="activeAssistGroup" class="content-card compact-card"><div class="card-heading"><h2>{{ activeAssistGroup.label }}（{{ activeAssistGroup.count }}）</h2><button class="subtle-button" @click="go('profile')">管理信息</button></div><p v-if="!activeAssistGroup.items.length" class="assist-empty">{{ search.trim() ? '没有匹配的内容。' : '这一类还没有可填内容。' }}</p><div v-for="entry in activeAssistGroup.items" :key="entry.item" class="assist-list"><h3 v-if="activeAssistGroup.items.length > 1 || entry.item > 1">第 {{ entry.item }} 段</h3><div v-for="fact in entry.rows" :key="`${fact.id}-${fact.value}`"><span><small>第 {{ fact.item || 1 }} 项</small><b>{{ fact.key }}</b></span><p :title="fact.value">{{ fact.value }}</p><button @click="useCenterFact(fact)">{{ props.embedded ? '填入' : '复制' }}</button></div></div></section>
      <div v-if="!centerFacts.length" class="empty-card"><span>▤</span><h2>还没有中心字段</h2><p>请先上传并识别简历，或在“我的信息”中补充资料。</p><button class="primary-button" @click="go('resume')">上传简历</button></div>
      <section class="tip-card"><span>💡</span><div><b>使用方式</b><p>先点击网申页面中的目标输入框，再点击任意中心字段。若没有预先选择输入框，插件会进入目标输入框点选模式。</p></div></section>
    </template>

    <template v-else>
      <section class="hero hero-settings relative mx-1 mb-2.5 flex min-h-[142px] items-center overflow-hidden rounded-xl border border-[#e3eef9] bg-gradient-to-br from-[#effcff] via-[#e5f8ff] to-[#d7f7f2] px-[18px] py-[21px]"><div class="relative z-[2] max-w-[62%]"><h1>个性化设置</h1><p>按你的需求定制 AI 助手</p><small>让求职更高效、更智能、更贴心。</small></div><img class="hero-illustration pointer-events-none absolute right-[-6px] bottom-[-21px] z-[1] h-[168px] w-[202px] object-contain object-bottom drop-shadow-[0_9px_16px_rgba(80,110,189,.12)] select-none" src="/assets/ui/settings-hero.png" alt="个性化设置插画" /></section>
      <section v-if="license" class="content-card settings-card">
        <div class="card-heading">
          <div class="title-with-icon"><span class="settings-icon green">✓</span><div><h2>插件授权</h2><p>离线激活码。清除后需要重新输入才能继续使用。</p></div></div>
          <span class="connection-pill ready">● 已激活</span>
        </div>
        <p class="license-meta">编号 {{ license.payload.id }} · {{ licenseExpiryLabel(license.payload) }}</p>
        <div class="setting-actions"><button class="danger-link" type="button" @click="deactivateLicense">清除激活</button></div>
      </section>
      <section class="content-card settings-card">
        <div class="card-heading">
          <div class="title-with-icon"><span class="settings-icon violet">◉</span><div><h2>AI 模型配置</h2><p>文本接口与图片能力分别验证，避免“可以聊天”被误判为“支持视觉”。</p></div></div>
          <span :class="['connection-pill', aiReady ? 'ready' : '']">● {{ aiReady ? '已配置' : '未配置' }}</span>
        </div>
        <label class="form-row"><span>API Base URL</span><input v-model.trim="aiSettings.url" type="url" placeholder="https://api.openai.com/v1" /></label>
        <label class="form-row"><span>API Key</span><div class="password-input"><input v-model="aiSettings.key" :type="showApiKey ? 'text' : 'password'" placeholder="请输入 API Key" autocomplete="off" /><button type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button></div></label>
        <label class="form-row"><span>模型（Model）</span><input v-model.trim="aiSettings.model" type="text" placeholder="请输入支持视觉的模型名称，例如 gpt-4o-mini" autocomplete="off" /></label>
        <div class="capability-status">
          <span :class="aiTextStatus">文本接口：{{ aiTextStatus === 'ready' ? '已验证' : aiTextStatus === 'failed' ? '失败' : aiTextStatus === 'testing' ? '测试中' : '未验证' }}</span>
          <span :class="aiVisionStatus">图片能力：{{ aiVisionStatus === 'ready' ? '已验证' : aiVisionStatus === 'failed' ? '不支持或失败' : aiVisionStatus === 'testing' ? '测试中' : '未验证' }}</span>
        </div>
        <div class="setting-actions"><button class="subtle-button" :disabled="busy || !aiReady" @click="verifyAiConfig">↗ 测试文本接口</button><button class="subtle-button" :disabled="busy || !aiReady" @click="verifyAiVision">▧ 测试图片能力</button><button class="primary-button" @click="saveAiConfig">保存配置</button><button class="danger-link" @click="removeAiConfig">删除</button></div>
        <div v-if="aiMessage" class="inline-notice">{{ aiMessage }}</div>
      </section>
      <section class="content-card settings-card"><div class="card-heading"><div class="title-with-icon"><span class="settings-icon blue">⚙</span><div><h2>功能设置</h2><p>自定义 AI 助手的行为和功能。</p></div></div></div><label class="toggle-row"><span><b>自动高亮填写字段</b><small>在支持的表单上标记已填写字段</small></span><input v-model="features.autoHighlight" type="checkbox" @change="saveFeatureSettings" /></label><label class="toggle-row"><span><b>自动复制到剪贴板</b><small>中心字段填入后保留一份内容用于手动粘贴</small></span><input v-model="features.autoClipboard" type="checkbox" @change="saveFeatureSettings" /></label><label class="toggle-row"><span><b>启用 AI 字段映射</b><small>智能匹配网页字段和你的简历内容</small></span><input v-model="features.aiMapping" type="checkbox" @change="saveFeatureSettings" /></label><label class="threshold-row"><span><b>AI 自动填写匹配阈值</b><small>高于阈值正常高亮；低于阈值仍自动填写并用橙色提示</small></span><div><input v-model.number="features.aiMatchThreshold" type="number" min="0" max="100" step="1" @change="saveFeatureSettings" /><em>%</em></div></label><label class="toggle-row"><span><b>调试模式</b><small>显示详细日志信息，仅用于排查问题</small></span><input v-model="features.debugMode" type="checkbox" @change="saveFeatureSettings" /></label><label class="toggle-row"><span><b>默认显示缩小态</b><small>打开插件时优先显示缩小态悬浮面板</small></span><input v-model="features.miniPanel" type="checkbox" @change="saveFeatureSettings" /></label></section>
      <section class="content-card settings-card">
        <div class="card-heading">
          <div class="title-with-icon"><span class="settings-icon blue">⛁</span><div><h2>站点规则（{{ siteRules.length }}）</h2><p>手工修正后，同站相同标签会按这个槽位识别。可以改回只认原来那一个字段。规则不含个人数据。</p></div></div>
        </div>
        <div class="setting-actions">
          <button class="subtle-button" :disabled="!siteRules.length" @click="exportRules">导出规则包</button>
          <label class="file-button">导入规则包<input type="file" accept=".json" @change="ruleFile = ($event.target as HTMLInputElement).files?.[0] || null" /></label>
          <button class="subtle-button" :disabled="!ruleFile" @click="importRuleFile">确认导入</button>
        </div>
        <div v-if="!siteRules.length" class="empty-state">还没有学习到规则。在填写面板中手工改选字段匹配后，这里会自动记录。</div>
        <div v-for="group in rulesByDomain" :key="group.domain" class="template-list">
          <div class="card-heading"><h2>{{ group.domain }}（{{ group.rules.length }}）</h2></div>
          <div v-for="rule in group.rules" :key="rule.id" class="resume-row">
            <div>
              <b>{{ ruleSlotName(rule.slot) }}</b>
              <span>{{ rule.labelKey ? `同类标签「${rule.labelKey}」` : `指纹 ${rule.fieldFingerprint.slice(0, 24)}` }}{{ ruleSectionName(rule.sectionId) ? ` · ${ruleSectionName(rule.sectionId)}` : '' }} · 命中 {{ rule.hitCount }} 次 · 失败 {{ rule.failCount }} 次 · {{ rule.origin === 'user-correction' ? '用户修正' : rule.origin === 'ai' ? 'AI 确认' : rule.origin === 'fill' ? '填写成功' : rule.origin === 'imported' ? '导入' : '内置' }}</span>
            </div>
            <span v-if="rule.disabled" class="current-pill">已停用{{ rule.failCount >= 3 ? '（疑似失效）' : '' }}</span>
            <button v-if="rule.labelKey" class="subtle-button" @click="limitRuleToFingerprint(rule)">仅此字段</button>
            <button class="subtle-button" @click="toggleRule(rule)">{{ rule.disabled ? '启用' : '停用' }}</button>
            <button class="danger-link" @click="deleteRule(rule)">删除</button>
          </div>
        </div>
      </section>
      <section class="content-card settings-card">
        <div class="card-heading">
          <div class="title-with-icon"><span class="settings-icon violet">Aa</span><div><h2>学到的字段别名（{{ learnedAliases.length }}）</h2><p>确认过的措辞下次按这个槽位识别。开始时间这类多个板块都有的标签，只在学到它的那个板块里生效。</p></div></div>
        </div>
        <div v-if="!learnedAliases.length" class="empty-state">还没有学到别名。在填写面板里改选字段后，这里会记下标签和槽位。</div>
        <div v-for="alias in learnedAliases" :key="(alias.sectionId || '') + alias.alias" class="resume-row">
          <div>
            <b>{{ alias.alias }}</b>
            <span>→ {{ ruleSlotName(alias.slot) }}{{ ruleSectionName(alias.sectionId) ? ` · 仅${ruleSectionName(alias.sectionId)}` : '' }} · 命中 {{ alias.hitCount }} 次 · 失败 {{ alias.failCount || 0 }} 次</span>
          </div>
          <span v-if="alias.disabled" class="current-pill">已停用（疑似失效）</span>
          <button class="subtle-button" @click="toggleAlias(alias)">{{ alias.disabled ? '启用' : '停用' }}</button>
          <button class="danger-link" @click="deleteAlias(alias)">删除</button>
        </div>
      </section>
      <section class="content-card settings-card"><div class="card-heading"><div class="title-with-icon"><span class="settings-icon cyan">▣</span><div><h2>数据管理</h2><p>管理本地存储的简历和个人信息。</p></div></div></div><div class="data-grid"><div><b>档案表格</b><label class="check-row"><input v-model="redactTable" type="checkbox" /> 导出时脱敏</label><div><button @click="exportTable('xlsx')">导出 Excel</button><button @click="exportTable('csv')">导出 CSV</button></div><label class="file-button">导入表格<input type="file" accept=".xlsx,.xls,.csv" @change="tableFile = ($event.target as HTMLInputElement).files?.[0] || null" /></label><button :disabled="!tableFile || busy" @click="importTable">确认导入</button></div><div><b>完整备份</b><label class="check-row"><input v-model="redactBackup" type="checkbox" /> 脱敏个人字段</label><div><button @click="exportBackup">导出备份</button></div><label class="file-button">选择备份<input type="file" accept=".json" @change="backupFile = ($event.target as HTMLInputElement).files?.[0] || null" /></label><button :disabled="!backupFile || busy" @click="importBackup">恢复备份</button></div></div><div class="danger-zone"><span><b>清除所有数据</b><small>删除当前浏览器中的个人信息、简历、模板和 AI 配置。</small></span><button @click="clearAll">清除所有数据</button></div></section>
      <section class="privacy-card"><span>◆</span><div><b>隐私说明</b><p>简历和个人信息默认存储在本地设备中。本地 OCR 完全在扩展内运行；只有 DOM 填写失败并触发视觉兜底时，控件附近的裁剪截图和 OCR 候选会发送到你配置的模型服务复核，不会发送完整页面截图。</p></div></section>
    </template>

    <footer class="app-footer">
      <div class="app-footer-heading">
        <div class="app-footer-brand"><img src="/assets/ui/brand-cover.png" alt="鸿途网申助手品牌图" /><span><b>鸿途网申助手</b><small>本地优先 · 免费使用 · 用技术让求职更美好</small></span></div>
        <button type="button" @click="go('settings')">⚙ 设置</button>
      </div>
      <div class="app-footer-details">
        <p><strong>作者：</strong>鸿途Ht</p>
        <p>本插件由 <strong>鸿途Ht</strong> 开发并免费发布，版权归作者所有。</p>
        <p><strong>激活码：</strong>加 QQ 群 <b>372728248</b> 免费获取</p>
        <p><strong>Bug反馈/使用交流：</strong>QQ 群 <b>372728248</b></p>
        <p><strong>说明：</strong>本插件仅免费使用，数据存储在浏览器本地；AI 服务需自行接入 OpenAI 格式接口。</p>
      </div>
      <p class="app-footer-copyright">Copyright © 2026 鸿途Ht. All Rights Reserved.</p>
    </footer>
  </main>
</template>
