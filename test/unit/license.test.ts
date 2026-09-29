import { describe, expect, it } from 'vitest'
import * as ed from '@noble/ed25519'
import { verifyLicense } from '../../src/features/license/license'

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function issue(payload: { v: 1; id: string; exp: number }, secret: Uint8Array): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const signature = await ed.signAsync(body, secret)
  return `HT1.${encodeBase64Url(body)}.${encodeBase64Url(signature)}`
}

describe('verifyLicense', () => {
  it('合法码通过', async () => {
    const secret = ed.utils.randomSecretKey()
    const publicKey = await ed.getPublicKeyAsync(secret)
    const code = await issue({ v: 1, id: 'abcd1234', exp: 0 }, secret)
    const result = await verifyLicense(`  ${code.slice(0, 20)}\n${code.slice(20)}  `, publicKey)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload).toEqual({ v: 1, id: 'abcd1234', exp: 0 })
  })

  it('改载荷失败', async () => {
    const secret = ed.utils.randomSecretKey()
    const publicKey = await ed.getPublicKeyAsync(secret)
    const code = await issue({ v: 1, id: 'abcd1234', exp: 0 }, secret)
    const [prefix, payload, signature] = code.split('.')
    const bytes = decodeBase64Url(payload)
    bytes[0] ^= 0xff
    const result = await verifyLicense(`${prefix}.${encodeBase64Url(bytes)}.${signature}`, publicKey)
    expect(result).toEqual({ ok: false, error: '激活码无效' })
  })

  it('错误签名失败', async () => {
    const secret = ed.utils.randomSecretKey()
    const publicKey = await ed.getPublicKeyAsync(secret)
    const code = await issue({ v: 1, id: 'abcd1234', exp: 0 }, secret)
    const other = await issue({ v: 1, id: 'abcd1234', exp: 0 }, ed.utils.randomSecretKey())
    const result = await verifyLicense(`${code.split('.').slice(0, 2).join('.')}.${other.split('.')[2]}`, publicKey)
    expect(result).toEqual({ ok: false, error: '激活码无效' })
  })

  it('过期失败', async () => {
    const secret = ed.utils.randomSecretKey()
    const publicKey = await ed.getPublicKeyAsync(secret)
    const code = await issue({ v: 1, id: 'abcd1234', exp: Math.floor(Date.now() / 1000) - 10 }, secret)
    const result = await verifyLicense(code, publicKey)
    expect(result).toEqual({ ok: false, error: '激活码已过期' })
  })
})
