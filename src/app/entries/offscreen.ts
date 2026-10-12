import { createWorker, OEM, PSM } from 'tesseract.js'
import type { OcrCandidate } from '../../features/autofill/write/visualConsensus'

interface LocalOcrMessage {
  type: 'LOCAL_OCR_WARMUP' | 'LOCAL_OCR_RECOGNIZE'
  image?: string
}

let workerPromise: ReturnType<typeof createWorker> | null = null

function localWorker(): ReturnType<typeof createWorker> {
  if (!workerPromise) {
    const base = chrome.runtime.getURL('assets/ocr')
    workerPromise = createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
      workerPath: `${base}/worker.min.js`,
      corePath: base,
      langPath: `${base}/lang`,
      workerBlobURL: false,
      gzip: true,
      errorHandler: error => console.warn('本地 OCR Worker 错误', error)
    }).then(async worker => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1'
      })
      return worker
    })
  }
  return workerPromise
}

function candidatesFrom(blocks: Tesseract.Block[] | null): OcrCandidate[] {
  const rows: Array<{ text: string; confidence: number; bbox: Tesseract.Bbox }> = []
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        if (line.text.trim()) rows.push({ text: line.text.trim(), confidence: line.confidence, bbox: line.bbox })
        for (const word of line.words || []) {
          if (word.text.trim()) rows.push({ text: word.text.trim(), confidence: word.confidence, bbox: word.bbox })
        }
      }
    }
  }
  const seen = new Set<string>()
  const result: OcrCandidate[] = []
  for (const row of rows) {
    const key = `${row.text}|${row.bbox.x0}|${row.bbox.y0}|${row.bbox.x1}|${row.bbox.y1}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      id: `ocr-${result.length + 1}`,
      text: row.text,
      confidence: Math.max(0, Math.min(1, row.confidence / 100)),
      box: { left: row.bbox.x0, top: row.bbox.y0, right: row.bbox.x1, bottom: row.bbox.y1 }
    })
    if (result.length >= 180) break
  }
  return result
}

async function handle(message: LocalOcrMessage): Promise<Record<string, unknown>> {
  try {
    const worker = await localWorker()
    if (message.type === 'LOCAL_OCR_WARMUP') return { ok: true, available: true, engine: 'tesseract.js' }
    if (!message.image) return { ok: false, available: true, error: '本地 OCR 缺少截图' }
    const image = message.image.startsWith('data:') ? message.image : `data:image/png;base64,${message.image}`
    const result = await worker.recognize(image, {}, { text: true, blocks: true })
    return { ok: true, available: true, engine: 'tesseract.js', text: result.data.text, candidates: candidatesFrom(result.data.blocks) }
  } catch (error) {
    workerPromise = null
    return { ok: false, available: false, error: `本地 OCR 初始化或识别失败：${String(error)}` }
  }
}

chrome.runtime.onMessage.addListener((message: LocalOcrMessage, _sender, respond) => {
  if (message?.type !== 'LOCAL_OCR_WARMUP' && message?.type !== 'LOCAL_OCR_RECOGNIZE') return false
  handle(message).then(respond)
  return true
})
