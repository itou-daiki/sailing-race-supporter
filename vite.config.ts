import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    // Wrangler generates and uploads Worker source maps separately. Browser
    // source maps are not part of the public Pages artifact.
    sourcemap: false,
  },
})
