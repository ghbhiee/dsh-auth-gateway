import { pluginBundle } from '../../scripts/tsdown-preset.ts'

export default pluginBundle('dsh-plugin-mobile-shell', {
  host: ['src/index.ts'],
  client: 'src/client/index.tsx',
})
