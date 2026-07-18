import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.worker.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          BACKUP_SIGNING_PRIVATE_KEY: 'worker-runtime-test-only',
        },
        serviceBindings: {
          ASSETS: async () => new Response('test asset'),
        },
      },
    })),
  ],
  test: {
    include: ['./test-worker/**/*.test.ts'],
    setupFiles: ['./test-worker/setup.ts'],
  },
})
