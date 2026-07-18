import { readFile, writeFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const root = new URL('../', import.meta.url)
const configurationUrl = new URL('config/backup-signing-keys.json', root)
const devVarsUrl = new URL('.dev.vars', root)

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

async function readText(url, fallback = '') {
  try {
    return await readFile(url, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const keyId = `srs-ed25519-${new Date().toISOString().replaceAll(/[-:TZ.]/gu, '').slice(0, 14)}`
const publicKey = base64Url(await webcrypto.subtle.exportKey('raw', keyPair.publicKey))
const privateKey = base64Url(await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey))
const current = JSON.parse(await readText(configurationUrl, '{"activeKeyId":"","publicKeys":{}}'))

let uniqueKeyId = keyId
if (current.publicKeys[uniqueKeyId]) uniqueKeyId = `${keyId}-${webcrypto.randomUUID().slice(0, 8)}`
current.activeKeyId = uniqueKeyId
current.publicKeys[uniqueKeyId] = publicKey
await writeFile(configurationUrl, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 })

const existingDevVars = await readText(devVarsUrl)
const secretLine = `BACKUP_SIGNING_PRIVATE_KEY="${privateKey}"`
const updatedDevVars = /(?:^|\n)BACKUP_SIGNING_PRIVATE_KEY=.*(?:\n|$)/u.test(existingDevVars)
  ? existingDevVars.replace(/(?:^|\n)BACKUP_SIGNING_PRIVATE_KEY=.*(?=\n|$)/u, (matched) => `${matched.startsWith('\n') ? '\n' : ''}${secretLine}`)
  : `${existingDevVars.trimEnd()}${existingDevVars.trim() ? '\n' : ''}${secretLine}\n`
await writeFile(devVarsUrl, updatedDevVars, { mode: 0o600 })

console.log(`Ed25519署名鍵 ${uniqueKeyId} を作成しました。`)
console.log('公開鍵はconfig/backup-signing-keys.json、秘密鍵はGit管理外の.dev.varsに保存しました。')
console.log('npm run deploy:worker でコードと秘密鍵を同じWorker版へ安全に登録してください。R2は不要です。')
