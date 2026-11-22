import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  server: { host: true, port: 5173, fs: { allow: ['..'] } },
  build: { target: 'es2022', sourcemap: false },
  resolve: {
    // The web demo (src/demo) reuses the server's modules in the browser.
    alias: {
      '@server': here('../server/src'),
      'node:events': here('src/demo/shims/events.ts'),
      'node:crypto': here('src/demo/shims/crypto.ts'),
    },
  },
})
