import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// The Cloudflare Vite integration emits a local-development copy beside the
// Worker bundle. It is not needed by `wrangler deploy` and must never survive
// in an artifact that could be archived or uploaded by another build system.
const generatedDevVars = resolve('dist/sailing_race_supporter/.dev.vars')
await rm(generatedDevVars, { force: true })
