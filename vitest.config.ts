import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    exclude: ['node_modules', '.output', '.wxt'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/entrypoints/**',
        'src/types/**',
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@engine': path.resolve(import.meta.dirname, 'src/engine'),
      '@background': path.resolve(import.meta.dirname, 'src/background'),
      '@lib': path.resolve(import.meta.dirname, 'src/lib'),
      '@types': path.resolve(import.meta.dirname, 'src/types'),
    },
  },
})
