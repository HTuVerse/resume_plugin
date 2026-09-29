/**
 * 本地发码。私钥写在 extension/license-private.json，不要提交，也不要打进扩展包。
 *
 *   node scripts/license-keygen.mjs init
 *   node scripts/license-keygen.mjs issue
 *   node scripts/license-keygen.mjs issue --days 365
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'

ed.hashes.sha512 = sha512

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const privatePath = join(extensionRoot, 'license-private.json')
const publicPath = join(extensionRoot, 'src', 'features', 'license', 'publicKey.ts')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function loadSecret() {
  if (!existsSync(privatePath)) fail('还没有私钥。请先运行：node scripts/license-keygen.mjs init')
  const stored = JSON.parse(readFileSync(privatePath, 'utf8'))
  if (typeof stored.secretKey !== 'string' || !/^[0-9a-f]{64}$/i.test(stored.secretKey)) fail('license-private.json 里的 secretKey 无效。')
  return Uint8Array.from(Buffer.from(stored.secretKey, 'hex'))
}

function writePublicKey(publicKey) {
  mkdirSync(dirname(publicPath), { recursive: true })
  const hex = Buffer.from(publicKey).toString('hex')
  writeFileSync(publicPath, `/** Ed25519 公钥。由 scripts/license-keygen.mjs init 写入，私钥不在此文件。 */\nexport const LICENSE_PUBLIC_KEY_HEX = '${hex}'\n`)
}

function init() {
  if (existsSync(privatePath)) fail(`私钥已存在：${privatePath}`)
  const secretKey = ed.utils.randomSecretKey()
  const publicKey = ed.getPublicKey(secretKey)
  writeFileSync(privatePath, `${JSON.stringify({ secretKey: Buffer.from(secretKey).toString('hex') }, null, 2)}\n`)
  writePublicKey(publicKey)
  console.log(`已生成私钥 ${privatePath}`)
  console.log(`已写入公钥 ${publicPath}`)
}

function readDays(argv) {
  const index = argv.indexOf('--days')
  if (index < 0) return 0
  const days = Number(argv[index + 1])
  if (!Number.isInteger(days) || days <= 0) fail('--days 需要正整数，例如 --days 365')
  return days
}

function issue(argv) {
  const secretKey = loadSecret()
  const days = readDays(argv)
  const payload = {
    v: 1,
    id: randomBytes(4).toString('hex'),
    exp: days === 0 ? 0 : Math.floor(Date.now() / 1000) + days * 86400
  }
  const body = Buffer.from(JSON.stringify(payload))
  const signature = ed.sign(body, secretKey)
  const code = `HT1.${body.toString('base64url')}.${Buffer.from(signature).toString('base64url')}`
  console.log(code)
  const expiry = payload.exp === 0 ? '永久' : new Date(payload.exp * 1000).toISOString()
  console.error(`编号 ${payload.id} · ${expiry}`)
}

const command = process.argv[2]
if (command === 'init') init()
else if (command === 'issue') issue(process.argv)
else fail('用法：node scripts/license-keygen.mjs init | issue [--days 365]')
