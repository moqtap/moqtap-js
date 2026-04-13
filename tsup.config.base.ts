import type { Options } from 'tsup'

export const baseConfig: Options = {
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
}
