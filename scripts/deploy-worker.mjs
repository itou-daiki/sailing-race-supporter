import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hasNoPendingMigrations, readDeploymentSettings } from './deploy-worker-settings.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const wranglerConfig = join(root, 'wrangler.worker.jsonc')
const wranglerExecutable = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const requiredSecretName = 'BACKUP_SIGNING_PRIVATE_KEY'

class CommandError extends Error {
  constructor(command, code, output) {
    super(`${command} が終了コード ${code} で失敗しました${output.trim() ? `\n${output.trim()}` : ''}`)
    this.name = 'CommandError'
  }
}

function run(command, args, { echo = true } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const value = chunk.toString()
      stdout += value
      if (echo) process.stdout.write(value)
    })
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString()
      stderr += value
      if (echo) process.stderr.write(value)
    })
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else rejectPromise(new CommandError(`${command} ${args.join(' ')}`, code ?? 1, `${stdout}\n${stderr}`))
    })
  })
}

function wrangler(args, options) {
  return run(process.execPath, [wranglerExecutable, ...args], options)
}

async function readSettings() {
  const [configuration, devVars, devVarsMetadata] = await Promise.all([
    readFile(wranglerConfig, 'utf8'),
    readFile(join(root, '.dev.vars'), 'utf8'),
    stat(join(root, '.dev.vars')),
  ])
  if (process.platform !== 'win32' && (devVarsMetadata.mode & 0o077) !== 0) {
    throw new Error('.dev.varsの権限を所有者だけが読める0600にしてください')
  }
  return readDeploymentSettings(configuration, devVars)
}

async function checkRemoteResources(settings) {
  const [bucket, migrations] = await Promise.all([
    wrangler(['r2', 'bucket', 'info', settings.bucketName, '--json'], { echo: false }),
    wrangler([
      'd1', 'migrations', 'list', settings.databaseName,
      '--remote', '--config', 'wrangler.worker.jsonc',
    ], { echo: false }),
  ])
  JSON.parse(bucket.stdout)
  const migrationOutput = `${migrations.stdout}\n${migrations.stderr}`
  if (!hasNoPendingMigrations(migrationOutput)) {
    throw new Error('D1に未適用マイグレーションがあります。先に npm run db:migrate:remote を実行してください')
  }
  console.log(`本番事前検査: D1 ${settings.databaseName} / R2 ${settings.bucketName} / 未適用migration 0`)
}

async function runBuild() {
  const npmExecutable = process.env.npm_execpath
  if (npmExecutable) {
    await run(process.execPath, [npmExecutable, 'run', 'build:cloudflare'])
  } else {
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:cloudflare'])
  }
  await run(process.execPath, [join(root, 'scripts', 'check-cloudflare-config.mjs')])
}

async function deploy(settings) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'srs-worker-deploy-'))
  const secretsFile = join(temporaryDirectory, 'secrets.json')
  try {
    await writeFile(
      secretsFile,
      JSON.stringify({ [requiredSecretName]: settings.signingPrivateKey }),
      { mode: 0o600 },
    )
    const revision = await run('git', ['rev-parse', '--short', 'HEAD'], { echo: false })
    await wrangler([
      'deploy', '--config', 'wrangler.worker.jsonc', '--strict',
      '--secrets-file', secretsFile,
      '--message', `Sailing Race Supporter ${revision.stdout.trim()}`,
    ])
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export async function main(args = process.argv.slice(2)) {
  const settings = await readSettings()
  try {
    await checkRemoteResources(settings)
  } catch (error) {
    if (error instanceof CommandError && /enable R2|code:\s*10042/iu.test(error.message)) {
      throw new Error(
        'Cloudflare R2が未有効です。Dashboardの Storage & databases → R2 → Overview で利用開始を完了してください',
        { cause: error },
      )
    }
    if (error instanceof CommandError && /code:\s*1000[67]|bucket[^\n]*(?:not found|does not exist)/iu.test(error.message)) {
      throw new Error(
        `R2バケット ${settings.bucketName} が見つかりません。npx wrangler r2 bucket create ${settings.bucketName} を実行してください`,
        { cause: error },
      )
    }
    throw error
  }
  if (args.includes('--check')) return
  await runBuild()
  await deploy(settings)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
