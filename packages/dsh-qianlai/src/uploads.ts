import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

import { refuse } from './period.js'

export interface UploadOptions { page?: number; sheet?: number; startRow?: number; offset?: number }
export interface UploadImage { type: 'image'; mediaType: string; data: string }
export interface UploadResult {
  accepted: boolean
  [key: string]: unknown
  images?: UploadImage[]
}

/** Read only received attachments. Parsing never runs inside a book write transaction. */
export async function readUpload(dshHome: string, path: string, options: UploadOptions = {}, signal?: AbortSignal): Promise<UploadResult> {
  if (signal?.aborted) return refuse('FILE_PARSE_CANCELLED', '文件读取已取消，没有导入或记账。')
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < (key === 'offset' ? 0 : 1))
      return refuse('POSITION_INVALID', '页码、工作表和起始行必须是正整数；offset 必须是非负整数。')
  }
  let real: string
  try {
    real = realpathSync(path)
    const root = realpathSync(join(dshHome, 'attachments'))
    if (!real.startsWith(root + sep)) return refuse('FILE_OUTSIDE_UPLOADS', '只能读老板在对话里上传的文件。')
    const stat = statSync(real)
    if (!stat.isFile()) return refuse('FILE_NOT_FOUND', '附件路径不是文件。')
    if (stat.size > 8 * 1024 * 1024) return refuse('FILE_TOO_LARGE', '文件超过 8 MB，请按月份或页码拆分后上传。')
  } catch {
    return refuse('FILE_NOT_FOUND', '找不到这个文件。只能读老板在对话里上传的文件。')
  }
  const ext = extname(real).toLowerCase()
  if (!['.csv', '.tsv', '.txt', '.xls', '.xlsx', '.pdf'].includes(ext))
    return refuse('FILE_TYPE_UNSUPPORTED', '支持 CSV、TSV、TXT、XLS、XLSX 和 PDF；图片可以直接上传查看。')
  return parseUpload(readFileSync(real), ext, options, signal)
}

/** The caller has already authorized and bounded the referenced PDF bytes. */
export function parseReferencedPdf(bytes: Uint8Array, page: number, signal?: AbortSignal): Promise<UploadResult> {
  if (!Number.isSafeInteger(page) || page < 1)
    return Promise.resolve(refuse('POSITION_INVALID', '页码必须是正整数。'))
  return parseUpload(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), '.pdf', { page }, signal)
}

async function parseUpload(bytes: Buffer, ext: string, options: UploadOptions, signal?: AbortSignal): Promise<UploadResult> {
  if ((ext === '.xlsx' && !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) ||
      (ext === '.xls' && !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) ||
      (ext === '.pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))))
    return refuse('FILE_FORMAT_MISMATCH', '文件内容与扩展名不符。请重新导出有效的 XLS/XLSX/PDF 文件，不要只修改文件名。')
  if (['.csv', '.tsv', '.txt'].includes(ext)) {
    let text: string
    const bom = bytes.subarray(0, 2).toString('hex')
    if (bom === 'fffe' || bom === 'feff') {
      text = new TextDecoder(bom === 'fffe' ? 'utf-16le' : 'utf-16be').decode(bytes)
    } else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { text = new TextDecoder('gb18030').decode(bytes) }
    }
    text = text.replace(/^\uFEFF/, '')
    const offset = options.offset ?? 0
    if (offset > text.length) return refuse('POSITION_INVALID', 'offset 超出文件长度。')
    const end = Math.min(offset + 200_000, text.length)
    return { accepted: true, format: ext.slice(1), text: text.slice(offset, end), truncated: end < text.length, nextOffset: end < text.length ? end : null }
  }
  return new Promise(resolve => {
    const worker = new Worker(new URL('./upload-worker.js', import.meta.url), {
      workerData: { bytes, ext, page: options.page ?? 1, sheet: options.sheet ?? 1, startRow: options.startRow ?? 1 },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let finished = false
    const finish = (result: UploadResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      void worker.terminate()
      resolve(result)
    }
    const cancelled = () => finish(refuse('FILE_PARSE_CANCELLED', '文件读取已取消，没有导入或记账。'))
    const timer = setTimeout(() => finish(refuse('FILE_PARSE_TIMEOUT', '文件解析超时，已停止本次解析，没有改动账本。请拆分文件后重试。')), 45_000)
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    worker.once('message', (result: UploadResult) => finish(result))
    worker.once('error', () => finish(refuse('FILE_PARSE_FAILED', '文件无法解析或超出解析内存，请检查文件或拆分后重试。没有改动账本。')))
    worker.once('exit', () => { if (!finished) finish(refuse('FILE_PARSE_FAILED', '文件解析提前结束，没有改动账本。')) })
  })
}
