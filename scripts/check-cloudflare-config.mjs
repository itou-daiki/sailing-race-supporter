import { readFile } from 'node:fs/promises'

const configuration = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const match = configuration.match(/"database_id"\s*:\s*"([^"]+)"/u)
const archiveBucket = configuration.match(
  /"binding"\s*:\s*"BACKUP_ARCHIVES"[\s\S]*?"bucket_name"\s*:\s*"([^"]+)"/u,
)
const signingKeys = JSON.parse(await readFile(new URL('../config/backup-signing-keys.json', import.meta.url), 'utf8'))

if (!match || match[1] === '00000000-0000-0000-0000-000000000000') {
  console.error([
    'Cloudflare D1のdatabase_idが未設定です。',
    '1. npx wrangler login',
    '2. npx wrangler d1 create sailing-race-supporter',
    '3. 表示されたdatabase_idをwrangler.jsoncへ設定',
    '4. npx wrangler r2 bucket create sailing-race-supporter-backups',
    '5. npm run db:migrate:remote',
    '6. npm run deploy:worker',
  ].join('\n'))
  process.exit(1)
}

if (!archiveBucket) {
  console.error('wrangler.jsoncにBACKUP_ARCHIVES R2バインディングがありません。')
  process.exit(1)
}

const activePublicKey = signingKeys.publicKeys?.[signingKeys.activeKeyId]
if (!signingKeys.activeKeyId || typeof activePublicKey !== 'string' || Buffer.from(activePublicKey, 'base64url').length !== 32) {
  console.error([
    'バックアップ用Ed25519公開鍵が未設定です。',
    '1. npm run backup-key:generate',
    '2. config/backup-signing-keys.jsonをコミット',
    '3. npm run cf:secret:backup-signing',
  ].join('\n'))
  process.exit(1)
}

console.log(`Cloudflare設定確認: D1 ${match[1]} / R2 ${archiveBucket[1]} / 署名鍵 ${signingKeys.activeKeyId}`)
