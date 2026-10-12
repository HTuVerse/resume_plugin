import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'public/assets/ocr')
const langOutput = resolve(output, 'lang')

await mkdir(langOutput, { recursive: true })

const copies = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz', 'lang/chi_sim.traineddata.gz'],
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
  ['node_modules/tesseract.js/LICENSE.md', 'tesseract.js-LICENSE.md'],
  ['node_modules/tesseract.js-core/LICENSE', 'tesseract.js-core-LICENSE.txt']
]

async function copyIfChanged(source, target) {
  const sourcePath = resolve(root, source)
  const targetPath = resolve(output, target)
  try {
    const [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)])
    if (sourceStat.size === targetStat.size) {
      const [sourceContent, targetContent] = await Promise.all([readFile(sourcePath), readFile(targetPath)])
      if (sourceContent.equals(targetContent)) return
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await copyFile(sourcePath, targetPath)
}

await Promise.all(copies.map(([source, target]) => copyIfChanged(source, target)))
console.log(`Prepared ${copies.length} local OCR assets in public/assets/ocr`)
