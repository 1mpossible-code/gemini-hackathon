import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { forgeAi } from './server/index.ts'
import { verifyPlugin } from './server/verify.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), forgeAi(), verifyPlugin()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
