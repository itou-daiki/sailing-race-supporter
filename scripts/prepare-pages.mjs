import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const clientDirectory = join('dist', 'client')
const entries = await readdir(clientDirectory)

await Promise.all(
  entries.map((entry) =>
    cp(join(clientDirectory, entry), join('dist', entry), {
      recursive: true,
      force: true,
    }),
  ),
)
