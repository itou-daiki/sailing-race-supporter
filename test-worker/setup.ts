import { env } from 'cloudflare:workers'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { beforeAll } from 'vitest'

interface WorkerTestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[]
}

const testEnv = env as WorkerTestBindings

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS)
})
