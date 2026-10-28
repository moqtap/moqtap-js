import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.config.base'

// One entry per subpath, so a consumer that imports `@moqtap/media/catalog`
// does not pull in the box walker or the NAL scanner.
export default defineConfig({
  ...baseConfig,
  dts: { compilerOptions: { composite: false, rootDir: undefined } },
  entry: {
    index: 'src/index.ts',
    bmff: 'src/bmff.ts',
    annexb: 'src/annexb.ts',
    catalog: 'src/catalog.ts',
  },
})
