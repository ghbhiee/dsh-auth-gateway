import { pluginBundle } from '../../scripts/tsdown-preset.ts'

export default pluginBundle('dsh-plugin-workbench', {
  host: ['src/index.ts'],
  client: 'src/client/index.tsx',
})
