import { readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outputDirectory = 'dist'
const defaultProductionOrigin = 'https://sailing-race-supporter.dit-lab.workers.dev'

const forbiddenFileNames = new Set([
  '.dev.vars',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
  'wrangler.worker.jsonc',
])

async function collectFiles(directory, relativeDirectory = '') {
  const directoryEntries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of directoryEntries) {
    const relativePath = join(relativeDirectory, entry.name)
    const absolutePath = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, relativePath)))
    } else {
      files.push(relativePath)
    }
  }

  return files
}

function productionOrigin() {
  const configured = process.env.SRS_PRODUCTION_APP_ORIGIN?.trim() || defaultProductionOrigin
  const url = new URL(configured)
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SRS_PRODUCTION_APP_ORIGIN must be an HTTPS origin without a path')
  }
  return url.origin
}

async function writeProductionRedirect() {
  const origin = productionOrigin()
  await Promise.all([
    writeFile(
      join(outputDirectory, '_redirects'),
      [
        '# Pages is a public entry point; authentication and event issuance run on the Worker.',
        '/sw.js /pages-migration-sw.js 200',
        `/* ${origin}/:splat 302`,
        '',
      ].join('\n'),
    ),
    writeFile(
      join(outputDirectory, 'pages-migration-sw.js'),
      `const PRODUCTION_ORIGIN = ${JSON.stringify(origin)}

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
    await self.registration.unregister()
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    await Promise.all(windows.map((client) => client.navigate(client.url)))
  })())
})

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  const source = new URL(event.request.url)
  event.respondWith(Response.redirect(\`${origin}\${source.pathname}\${source.search}\`, 302))
})
`,
    ),
  ])
}

await writeProductionRedirect()

const publishedFiles = await collectFiles(outputDirectory)
const forbiddenFiles = publishedFiles.filter((file) => {
  return forbiddenFileNames.has(basename(file)) || file.endsWith('.map')
})

if (forbiddenFiles.length > 0) {
  throw new Error(
    `Pages output contains forbidden files: ${forbiddenFiles.join(', ')}`,
  )
}

if (!publishedFiles.includes('index.html')) {
  throw new Error('Pages output does not contain index.html')
}

if (!publishedFiles.includes('_redirects') || !publishedFiles.includes('pages-migration-sw.js')) {
  throw new Error('Pages output does not contain the production Worker redirect')
}

if (publishedFiles.some((file) => file.startsWith(`client${join('', '/')}`))) {
  throw new Error('Pages output unexpectedly contains a nested client directory')
}
