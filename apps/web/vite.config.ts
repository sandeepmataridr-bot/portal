import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The stand-alone home page build (vite.landing.config.ts) writes here;
  // watching it while it is rewritten crashes the dev server on Windows.
  server: { watch: { ignored: ['**/dist-landing/**'] } },
})
