import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const devVars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')
const match = devVars.match(/(?:^|\n)BACKUP_SIGNING_PRIVATE_KEY=["']?([^\n"']+)["']?(?:\n|$)/u)
if (!match) throw new Error('.dev.varsにBACKUP_SIGNING_PRIVATE_KEYがありません。先に npm run backup-key:generate を実行してください。')

const child = spawn('npx', ['wrangler', 'secret', 'put', 'BACKUP_SIGNING_PRIVATE_KEY'], {
  cwd: new URL('../', import.meta.url),
  stdio: ['pipe', 'inherit', 'inherit'],
})
child.stdin.end(`${match[1]}\n`)
child.on('exit', (code) => process.exit(code ?? 1))
