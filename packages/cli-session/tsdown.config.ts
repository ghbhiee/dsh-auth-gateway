import { pluginBundle } from '../../scripts/tsdown-preset.ts'

export default pluginBundle('dsh-plugin-cli-session', {
  host: ['src/index.ts', 'src/startup.ts'],
})
