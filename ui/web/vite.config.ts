import path from 'path'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  root: path.resolve(__dirname),
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5175',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
