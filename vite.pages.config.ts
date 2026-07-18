import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cloudflare Pages is a static preview surface. Keep its build independent
// from Wrangler, Worker bindings, Durable Objects, and deployment secrets.
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
  },
})
