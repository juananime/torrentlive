import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: '.',
  // Electron loads the built index.html off the filesystem, so every asset
  // reference has to be relative rather than rooted at "/".
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false
  },
  server: {
    port: 5273,
    strictPort: true
  },
  clearScreen: false
})
