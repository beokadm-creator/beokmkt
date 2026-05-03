import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const target = env.VITE_API_TARGET || 'http://localhost:8787'
  const rewritePrefix = env.VITE_API_REWRITE_PREFIX || ''

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (p) => `${rewritePrefix}${p}`,
        },
      },
    },
  }
})
