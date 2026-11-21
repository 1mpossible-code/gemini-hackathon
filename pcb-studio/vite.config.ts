import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { forgeAi } from './server/index.ts'
import { conceptPlugin } from './server/concept.ts'
import { verifyPlugin } from './server/verify.ts'
import { shopPlugin } from './server/shop.ts'
import { repairPlugin } from './server/repair.ts'

const RESEARCH = process.env.FORGE_RESEARCH_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss(), forgeAi(), conceptPlugin(), verifyPlugin(), shopPlugin(), repairPlugin()],
  // The research swarm (forge_research FastAPI) runs on :8000. Its page is shown in the
  // Research tab under /research; its own /api and /static paths are forwarded too.
  // /api/generate and /api/verify are served by the plugins above and never reach it.
  server: {
    headers: { 'Cache-Control': 'no-store' },
    // Poll so edits from another process show up even when inotify misses them.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/research': {
        target: RESEARCH,
        rewrite: (p) => p.replace(/^\/research/, '') || '/',
        timeout: 0,
        proxyTimeout: 0,
      },
      '/static': { target: RESEARCH, timeout: 0, proxyTimeout: 0 },
      // PCB routes stay on this dev server. Everything else under /api is the research studio.
      '/api': {
        target: RESEARCH,
        timeout: 0,
        proxyTimeout: 0,
        bypass(req) {
          const url = req.url ?? ''
          if (/^\/api\/(generate|verify|repair|shop|concept)(\/|$|\?)/.test(url)) return url
        },
      },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
