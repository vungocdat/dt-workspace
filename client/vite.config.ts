import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:3333',
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
})
