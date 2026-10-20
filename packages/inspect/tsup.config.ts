import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.config.base'

export default defineConfig({
  ...baseConfig,
  dts: { compilerOptions: { composite: false, rootDir: undefined } },
  entry: { index: 'src/index.ts' },
})
