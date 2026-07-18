import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['./test/**/*.test.{ts,tsx,mjs}'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: true,
  },
})
