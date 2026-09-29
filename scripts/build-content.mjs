import { build } from 'esbuild'

await build({
  entryPoints: ['src/app/entries/content.ts'],
  outfile: 'dist/content.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  minify: true
})
