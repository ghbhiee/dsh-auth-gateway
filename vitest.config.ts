import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    environment: 'node',
    // dsh-client-ui-primitives imports katex's stylesheet; Vite has to process
    // that dependency for the CSS import to resolve in a test run.
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
  },
})
