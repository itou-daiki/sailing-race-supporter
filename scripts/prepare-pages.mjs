import { cp, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outputDirectory = 'dist'
const clientDirectory = join(outputDirectory, 'client')
const entries = await readdir(clientDirectory)
const generatedEntries = await readdir(outputDirectory)

// The Cloudflare Vite plugin emits both the browser bundle and a Worker bundle.
// Pages must publish only the browser bundle: remove stale root assets and every
// generated sibling while preserving the client directory as the copy source.
await Promise.all(
  generatedEntries
    .filter((entry) => entry !== 'client')
    .map((entry) =>
      rm(join(outputDirectory, entry), { recursive: true, force: true }),
    ),
)

await Promise.all(
  entries.map((entry) =>
    cp(join(clientDirectory, entry), join(outputDirectory, entry), {
      recursive: true,
      force: true,
    }),
  ),
)

await rm(clientDirectory, { recursive: true, force: true })

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
