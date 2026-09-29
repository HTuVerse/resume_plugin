import { build } from 'esbuild'

await build({
  entryPoints: ['src/app/entries/background.ts'],
  outfile: 'dist/background.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  minify: true
})
