import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    reporters: ['verbose'],
    exclude: ['node_modules/**', 'dist/**', 'external/**', '**/.{tmp,temp}/**', '**/.tmp/**']
  }
})
