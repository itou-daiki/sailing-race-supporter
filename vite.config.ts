import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      // Keep the Workers configuration out of the root wrangler.jsonc name.
      // Cloudflare Pages otherwise treats the Worker-only bindings as a Pages
      // deployment configuration during Git builds.
      configPath: './wrangler.worker.jsonc',
    }),
  ],
  build: {
    // Wrangler generates and uploads Worker source maps separately. Browser
    // source maps are not part of the public Pages artifact.
    sourcemap: false,
  },
})
