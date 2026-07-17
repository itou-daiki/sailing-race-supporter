import { readFile } from 'node:fs/promises'

const configuration = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const match = configuration.match(/"database_id"\s*:\s*"([^"]+)"/u)

if (!match || match[1] === '00000000-0000-0000-0000-000000000000') {
  console.error([
    'Cloudflare D1のdatabase_idが未設定です。',
    '1. npx wrangler login',
    '2. npx wrangler d1 create sailing-race-supporter',
    '3. 表示されたdatabase_idをwrangler.jsoncへ設定',
    '4. npm run db:migrate:remote',
    '5. npm run deploy:worker',
  ].join('\n'))
  process.exit(1)
}

console.log(`Cloudflare設定確認: D1 ${match[1]}`)
