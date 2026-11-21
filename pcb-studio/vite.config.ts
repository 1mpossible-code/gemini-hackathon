import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { forgeAi } from './server/index.ts'
import { verifyPlugin } from './server/verify.ts'

const RESEARCH = process.env.FORGE_RESEARCH_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss(), forgeAi(), verifyPlugin()],
  // The research swarm (forge_research FastAPI) runs on :8000. Its page is shown in the
  // Research tab under /research; its own /api and /static paths are forwarded too.
  // /api/generate and /api/verify are served by the plugins above and never reach it.
  server: {
    proxy: {
      '/research': { target: RESEARCH, rewrite: (p) => p.replace(/^\/research/, '') || '/' },
      '/static': RESEARCH,
      '/api': RESEARCH,
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
