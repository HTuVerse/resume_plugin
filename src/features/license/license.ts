import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { LICENSE_PUBLIC_KEY_HEX } from './publicKey'

ed.hashes.sha512 = message => sha512(message)

const STORAGE_KEY = 'licenseV1'
const PREFIX = 'HT1'

export interface LicensePayload {
  v: 1
  id: string
  exp: number
}

export interface LicenseRecord {
  code: string
  payload: LicensePayload
  activatedAt: string
}

export type LicenseCheck =
  | { ok: true; payload: LicensePayload }
  | { ok: false; error: string }

export const LICENSE_REQUIRED_MESSAGE = '请先激活插件'

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error('公钥无效')
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

const defaultPublicKey = hexToBytes(LICENSE_PUBLIC_KEY_HEX)

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  try {
    const binary = atob(padded + pad)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, '')
}

function isPayload(value: unknown): value is LicensePayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<LicensePayload>
  return payload.v === 1
    && typeof payload.id === 'string'
    && /^[0-9a-f]{8}$/.test(payload.id)
    && typeof payload.exp === 'number'
    && Number.isInteger(payload.exp)
    && payload.exp >= 0
}

export async function verifyLicense(code: string, publicKey: Uint8Array = defaultPublicKey, now = Date.now()): Promise<LicenseCheck> {
  const parts = normalizeCode(code).split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: '激活码格式不正确' }
  const payloadBytes = decodeBase64Url(parts[1])
  const signature = decodeBase64Url(parts[2])
  if (!payloadBytes || signature?.length !== 64) return { ok: false, error: '激活码格式不正确' }
  let signatureOk = false
  try {
    signatureOk = ed.verify(signature, payloadBytes, publicKey)
  } catch {
    return { ok: false, error: '激活码无效' }
  }
  if (!signatureOk) return { ok: false, error: '激活码无效' }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return { ok: false, error: '激活码无效' }
  }
  if (!isPayload(parsed)) return { ok: false, error: '激活码无效' }
  if (parsed.exp !== 0 && now >= parsed.exp * 1000) return { ok: false, error: '激活码已过期' }
  return { ok: true, payload: parsed }
}

function isStoredRecord(value: unknown): value is { code: string; activatedAt: string } {
  if (!value || typeof value !== 'object') return false
  const record = value as { code?: unknown; activatedAt?: unknown }
  return typeof record.code === 'string' && typeof record.activatedAt === 'string'
}

export async function loadLicense(now = Date.now()): Promise<LicenseRecord | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const record = stored[STORAGE_KEY]
  if (!isStoredRecord(record)) return null
  const check = await verifyLicense(record.code, undefined, now)
  if (!check.ok) {
    await chrome.storage.local.remove(STORAGE_KEY)
    return null
  }
  return { code: normalizeCode(record.code), payload: check.payload, activatedAt: record.activatedAt }
}

export async function activate(code: string): Promise<LicenseRecord> {
  const check = await verifyLicense(code)
  if (!check.ok) throw new Error(check.error)
  const record: LicenseRecord = {
    code: normalizeCode(code),
    payload: check.payload,
    activatedAt: new Date().toISOString()
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: record })
  return record
}

export async function clearLicense(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY)
}

export function licenseExpiryLabel(payload: LicensePayload): string {
  if (payload.exp === 0) return '永久有效'
  return `有效期至 ${new Date(payload.exp * 1000).toLocaleString('zh-CN', { hour12: false })}`
}
