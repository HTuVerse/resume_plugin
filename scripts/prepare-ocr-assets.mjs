import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'public/assets/ocr')
const langOutput = resolve(output, 'lang')

await mkdir(langOutput, { recursive: true })

// 直接拷贝的非压缩文件（上架微软商店会拒绝压缩包，故语言数据单独解压，见下方 gunzips）。
const copies = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['node_modules/tesseract.js/LICENSE.md', 'tesseract.js-LICENSE.md'],
  ['node_modules/tesseract.js-core/LICENSE', 'tesseract.js-core-LICENSE.txt']
]

// 语言模型在 npm 包里只提供 .gz。上架微软/Edge 商店不允许扩展包内再含压缩包（.gz/.zip 等），
// 因此构建时解压成未压缩的 .traineddata，并配合 offscreen.ts 的 gzip:false 加载。
const gunzips = [
  ['node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz', 'lang/chi_sim.traineddata'],
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata']
]

// 历史构建可能残留的压缩语言包，必须删除，否则会一起打进 dist.zip 导致商店拒绝。
const staleArchives = ['lang/chi_sim.traineddata.gz', 'lang/eng.traineddata.gz']

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

async function gunzipIfChanged(source, target) {
  const sourcePath = resolve(root, source)
  const targetPath = resolve(output, target)
  const decompressed = gunzipSync(await readFile(sourcePath))
  try {
    const existing = await readFile(targetPath)
    if (existing.equals(decompressed)) return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await writeFile(targetPath, decompressed)
}

await Promise.all([
  ...copies.map(([source, target]) => copyIfChanged(source, target)),
  ...gunzips.map(([source, target]) => gunzipIfChanged(source, target)),
  ...staleArchives.map(target => rm(resolve(output, target), { force: true }))
])
console.log(`Prepared ${copies.length + gunzips.length} local OCR assets (language data uncompressed) in public/assets/ocr`)
