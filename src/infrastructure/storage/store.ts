import type { AiSettings, BackupPayload, CurrentResume, Fact, LearnedAlias, ResumeTemplate, SiteRule, StoredProfile } from '../../domain/types'
import { isRedacted, maskApiUrl, redactFacts } from '../privacy/privacy'
import { foldProfileFacts } from '../../features/rag/knowledge'
import { LEARNED_ALIASES_KEY, loadLearnedAliases, saveLearnedAliases } from '../../features/ontology/learnedAliases'
import { SITE_RULES_KEY, loadSiteRules, saveSiteRules } from '../../features/siteRules/ruleStore'
import { AI_SLOT_CACHE_KEY } from '../../features/ai/slotMatchCache'
import { FILL_RECIPES_KEY, loadFillRecipes, saveFillRecipes } from '../../features/autofill/write/fillRecipes'

const PROFILE_KEY = 'resumeProfileV1'
const AI_SETTINGS_KEY = 'aiSettingsV1'
const TEMPLATES_KEY = 'resumeTemplatesV1'
const CURRENT_RESUME_KEY = 'currentResumeV2'
const RESUME_LIBRARY_KEY = 'resumeLibraryV1'
const SLOT_OVERRIDES_KEY = 'slotOverridesV1'

export async function loadProfile(): Promise<StoredProfile> {
  const result = await chrome.storage.local.get(PROFILE_KEY)
  const stored = result[PROFILE_KEY] as StoredProfile | undefined
  return stored && Array.isArray(stored.facts)
    ? {
        // Older builds accidentally copied resume/AI extraction results into
        // the profile store. Keep “My Info” user-owned by dropping those rows.
        facts: foldProfileFacts(stored.facts.filter(isFact).filter(fact => fact.source !== 'resume' && fact.source !== 'ai')
          .slice(0, 5000).map(fact => ({ ...fact, source: 'profile' as const }))),
        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : ''
      }
    : { facts: [], updatedAt: '' }
}

function isFact(value: unknown): value is Fact {
  if (!value || typeof value !== 'object') return false
  const f = value as Partial<Fact>
  return typeof f.id === 'string' && f.id.length <= 200 && typeof f.group === 'string' && f.group.length <= 200 &&
    typeof f.key === 'string' && f.key.length <= 200 && typeof f.value === 'string' && f.value.length <= 100_000
}

export async function saveProfile(facts: Fact[]): Promise<void> {
  const profileFacts = foldProfileFacts(facts.filter(fact => fact.source !== 'resume' && fact.source !== 'ai')
    .map(fact => ({ ...fact, source: 'profile' as const })))
  await chrome.storage.local.set({ [PROFILE_KEY]: { facts: profileFacts, updatedAt: new Date().toISOString() } })
}

export async function clearProfile(): Promise<void> {
  await chrome.storage.local.remove(PROFILE_KEY)
}

export async function loadCurrentResume(): Promise<CurrentResume | null> {
  const result = await chrome.storage.local.get(CURRENT_RESUME_KEY)
  const stored = result[CURRENT_RESUME_KEY] as CurrentResume | undefined
  return stored && typeof stored.id === 'string' && typeof stored.fileName === 'string' &&
    ['pdf', 'docx', 'txt'].includes(stored.fileType) && typeof stored.extractedText === 'string' &&
    Array.isArray(stored.facts) && typeof stored.parsedAt === 'string'
    ? { ...stored, facts: stored.facts.filter(isFact).slice(0, 5000).map(fact => ({ ...fact, source: 'resume' as const })) }
    : null
}

export async function saveCurrentResume(resume: CurrentResume): Promise<void> {
  await chrome.storage.local.set({ [CURRENT_RESUME_KEY]: { ...resume, facts: resume.facts.map(fact => ({ ...fact, source: 'resume' })) } })
}

export async function clearCurrentResume(): Promise<void> {
  await chrome.storage.local.remove(CURRENT_RESUME_KEY)
}

export async function loadResumeLibrary(): Promise<CurrentResume[]> {
  const result = await chrome.storage.local.get(RESUME_LIBRARY_KEY)
  const stored = result[RESUME_LIBRARY_KEY] as unknown
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is CurrentResume => Boolean(item && typeof item === 'object' &&
    typeof item.id === 'string' && typeof item.fileName === 'string' &&
    ['pdf', 'docx', 'txt'].includes(item.fileType) && typeof item.extractedText === 'string' &&
    Array.isArray(item.facts) && typeof item.parsedAt === 'string'))
    .map(item => ({ ...item, facts: item.facts.filter(isFact).slice(0, 5000).map(fact => ({ ...fact, source: 'resume' as const })) }))
    .slice(0, 30)
}

export async function saveResumeLibrary(resumes: CurrentResume[]): Promise<void> {
  await chrome.storage.local.set({
    [RESUME_LIBRARY_KEY]: resumes.slice(0, 30).map(resume => ({
      ...resume,
      facts: resume.facts.map(fact => ({ ...fact, source: 'resume' as const }))
    }))
  })
}

export async function loadAiSettings(): Promise<AiSettings> {
  const result = await chrome.storage.local.get(AI_SETTINGS_KEY)
  const stored = result[AI_SETTINGS_KEY] as Partial<AiSettings> | undefined
  return {
    url: typeof stored?.url === 'string' ? stored.url : '',
    key: typeof stored?.key === 'string' ? stored.key : '',
    model: typeof stored?.model === 'string' ? stored.model : ''
  }
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await chrome.storage.local.set({
    [AI_SETTINGS_KEY]: {
      url: settings.url.trim(),
      key: settings.key.trim(),
      model: settings.model.trim()
    }
  })
}

export async function clearAiSettings(): Promise<void> {
  await chrome.storage.local.remove(AI_SETTINGS_KEY)
}

export async function loadTemplates(): Promise<ResumeTemplate[]> {
  const result = await chrome.storage.local.get(TEMPLATES_KEY)
  const stored = result[TEMPLATES_KEY] as unknown
  return Array.isArray(stored) ? stored.filter(isTemplate).slice(0, 100) : []
}

function isTemplate(value: unknown): value is ResumeTemplate {
  if (!value || typeof value !== 'object') return false
  const template = value as Partial<ResumeTemplate>
  return typeof template.id === 'string' && template.id.length <= 200 && typeof template.name === 'string' &&
    template.name.trim().length > 0 && template.name.length <= 200 && Array.isArray(template.facts) &&
    template.facts.every(isFact)
}

export async function saveTemplates(templates: ResumeTemplate[]): Promise<void> {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates })
}

export async function createBackup(redactSensitive = true): Promise<BackupPayload> {
  const ai = await loadAiSettings()
  const profile = await loadProfile()
  const templates = await loadTemplates()
  const currentResume = await loadCurrentResume()
  const resumes = await loadResumeLibrary()
  const backupResume = currentResume
    ? {
        ...currentResume,
        // The extracted source is often more sensitive than any individual
        // fact, so never include it in a redacted backup.
        extractedText: redactSensitive ? '[已脱敏]' : currentResume.extractedText,
        fileName: redactSensitive ? '已脱敏简历' : currentResume.fileName,
        facts: redactSensitive ? redactFacts(currentResume.facts) : currentResume.facts
      }
    : undefined
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    redacted: redactSensitive,
    profile: {
      ...profile,
      facts: redactSensitive ? redactFacts(profile.facts) : profile.facts
    },
    templates: templates.map(template => ({
      ...template,
      facts: redactSensitive ? redactFacts(template.facts) : template.facts
    })),
    currentResume: backupResume,
    resumes: resumes.map(resume => ({
      ...resume,
      extractedText: redactSensitive ? '[已脱敏]' : resume.extractedText,
      fileName: redactSensitive ? '已脱敏简历' : resume.fileName,
      facts: redactSensitive ? redactFacts(resume.facts) : resume.facts
    })),
    aiSettings: {
      url: maskApiUrl(ai.url),
      key: '••••••••',
      model: ai.model
    },
    // 站点规则与学到的字段别名都不含个人数据，可不脱敏导出
    siteRules: await loadSiteRules(),
    learnedAliases: await loadLearnedAliases(),
    fillRecipes: await loadFillRecipes()
  }
}

function removeMaskedFacts(facts: Fact[]): Fact[] {
  return facts.filter(fact => !(isRedacted(fact.value) && (fact.sensitive || /姓名|手机|电话|邮箱|email|phone|地址|身份证|证件号|银行卡|token|secret|password|api\s*key/i.test(fact.key))))
}

function checkedBackup(payload: unknown): BackupPayload {
  if (!payload || typeof payload !== 'object') throw new Error('备份文件格式无效。')
  const value = payload as Partial<BackupPayload>
  // v2（1.1 版本）与 v3（2.0，新增 siteRules）均可恢复；读 v2 时站点规则视为空
  if ((value.version !== 2 && value.version !== 3) || !value.profile || !Array.isArray(value.profile.facts) || !Array.isArray(value.templates)) {
    throw new Error('备份文件版本不兼容或内容不完整。')
  }
  if (!value.profile.facts.every(isFact) || !value.templates.every(isTemplate)) throw new Error('备份文件包含无效字段，已拒绝恢复。')
  if (value.currentResume && (!Array.isArray(value.currentResume.facts) || typeof value.currentResume.extractedText !== 'string')) {
    throw new Error('备份中的当前简历数据无效。')
  }
  if (value.resumes && (!Array.isArray(value.resumes) || value.resumes.some(resume => !Array.isArray(resume.facts) || typeof resume.extractedText !== 'string'))) {
    throw new Error('备份中的简历列表数据无效。')
  }
  return value as BackupPayload
}

export async function restoreBackup(payload: unknown): Promise<void> {
  const checked = checkedBackup(payload)
  const profileFacts = removeMaskedFacts(checked.profile.facts)
  const templates = checked.templates.map(template => ({ ...template, facts: removeMaskedFacts(template.facts) }))
  await saveProfile(profileFacts)
  await saveTemplates(templates)
  // Restore is a replacement, not a merge: an absent resume must not leave an
  // old resume behind after the user restores a clean backup.
  if (checked.currentResume) {
    await saveCurrentResume({ ...checked.currentResume, facts: removeMaskedFacts(checked.currentResume.facts) })
  } else {
    await clearCurrentResume()
  }
  await saveResumeLibrary((checked.resumes || []).map(resume => ({ ...resume, facts: removeMaskedFacts(resume.facts) })))
  // v3 备份包含站点规则；v2 备份视为无规则（不清空现有规则）
  if (checked.version === 3 && Array.isArray(checked.siteRules)) {
    await saveSiteRules(checked.siteRules as SiteRule[])
  }
  if (Array.isArray(checked.learnedAliases)) {
    await saveLearnedAliases(checked.learnedAliases as LearnedAlias[])
  }
  if (Array.isArray(checked.fillRecipes)) {
    await saveFillRecipes(checked.fillRecipes)
  }
  // Never restore credentials from an imported file. The exported API fields
  // are intentionally informational only and the current browser credential
  // remains untouched.
}

export async function clearAllLocalData(): Promise<void> {
  await chrome.storage.local.remove([
    PROFILE_KEY, AI_SETTINGS_KEY, TEMPLATES_KEY, CURRENT_RESUME_KEY, RESUME_LIBRARY_KEY,
    'featureSettingsV1', SITE_RULES_KEY, SLOT_OVERRIDES_KEY, AI_SLOT_CACHE_KEY, LEARNED_ALIASES_KEY, FILL_RECIPES_KEY
  ])
}
