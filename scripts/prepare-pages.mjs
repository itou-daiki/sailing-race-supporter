import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outputDirectory = 'dist'

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

if (publishedFiles.some((file) => file.startsWith(`client${join('', '/')}`))) {
  throw new Error('Pages output unexpectedly contains a nested client directory')
}
