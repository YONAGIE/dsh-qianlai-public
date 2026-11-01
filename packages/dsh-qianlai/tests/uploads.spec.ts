import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import { readUpload } from '../lib/uploads.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qianlai-upload-'))
  const directory = join(home, 'attachments')
  mkdirSync(directory)
  return { home, directory }
}

describe('财务上传解析', () => {
  it.each(['xlsx', 'xls'] as const)('%s 保留日期、金额显示值、原行号和全部工作表', async extension => {
    const { home, directory } = fixture()
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['date', 'amount', 'account'], ['2026-01-02', '1287.13', '0001234']])
    XLSX.utils.book_append_sheet(book, sheet, 'Statement')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second sheet']]), 'Notes')
    const path = join(directory, `statement.${extension}`)
    writeFileSync(path, XLSX.write(book, { type: 'buffer', bookType: extension === 'xls' ? 'biff8' : 'xlsx' }))
    const result = await readUpload(home, path)
    expect(result).toMatchObject({ accepted: true, sheets: ['Statement', 'Notes'], nextSheet: 2, totalRows: 2 })
    expect(result.rows).toEqual([{ rowNumber: 1, cells: ['date', 'amount', 'account'] }, { rowNumber: 2, cells: ['2026-01-02', '1287.13', '0001234'] }])
    expect(await readUpload(home, path, { sheet: 2 })).toMatchObject({ accepted: true, sheetName: 'Notes', nextSheet: null })
  })

  it('大表续读不丢行、不执行公式', async () => {
    const { home, directory } = fixture()
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet(Array.from({ length: 215 }, (_, i) => [`row-${i + 1}`]))
    sheet.B1 = { t: 'n', f: '1+1' }
    sheet['!ref'] = 'A1:B215'
    XLSX.utils.book_append_sheet(book, sheet, 'Data')
    const path = join(directory, 'many.xlsx')
    writeFileSync(path, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    expect(await readUpload(home, path)).toMatchObject({ accepted: true, nextStartRow: 201 })
    const tail = await readUpload(home, path, { startRow: 201 })
    expect(tail).toMatchObject({ accepted: true, nextStartRow: null })
    expect((tail.rows as unknown[]).length).toBe(15)
  })

  it('PDF 每一页均提供原图，混合页与纯扫描页不会默默漏读', async () => {
    const { home, directory } = fixture()
    const pdf = await PDFDocument.create()
    const canvas = createCanvas(300, 100)
    const context = canvas.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, 300, 100)
    context.fillStyle = '#000'
    context.font = '24px sans-serif'
    context.fillText('SCAN 1287.13', 10, 50)
    const scan = await pdf.embedPng(canvas.toBuffer('image/png'))
    const mixed = pdf.addPage([400, 300])
    mixed.drawText('Synthetic statement')
    mixed.drawImage(scan, { x: 10, y: 100, width: 300, height: 100 })
    pdf.addPage([400, 300]).drawImage(scan, { x: 10, y: 100, width: 300, height: 100 })
    const path = join(directory, 'mixed.pdf')
    writeFileSync(path, await pdf.save())
    const first = await readUpload(home, path)
    expect(first).toMatchObject({ accepted: true, totalPages: 2, nextPage: 2 })
    expect(first.text).toContain('Synthetic statement')
    expect(first.images?.[0]?.data.length).toBeGreaterThan(100)
    const second = await readUpload(home, path, { page: 2 })
    expect(second).toMatchObject({ accepted: true, nextPage: null, text: '' })
    expect(second.images?.[0]?.data.length).toBeGreaterThan(100)
    expect(await readUpload(home, path, { page: 3 })).toMatchObject({ accepted: false, code: 'FILE_PARSE_FAILED' })
  })

  it('拒绝越界、符号链接逃逸、伪造格式与非法分页', async () => {
    const { home, directory } = fixture()
    const outside = join(home, 'private.txt')
    writeFileSync(outside, 'private')
    const link = join(directory, 'link.txt')
    symlinkSync(outside, link)
    expect(await readUpload(home, link)).toMatchObject({ accepted: false, code: 'FILE_OUTSIDE_UPLOADS' })
    const fake = join(directory, 'fake.xlsx')
    writeFileSync(fake, 'not an excel workbook')
    expect(await readUpload(home, fake)).toMatchObject({ accepted: false, code: 'FILE_FORMAT_MISMATCH' })
    expect(await readUpload(home, fake, { page: 0 })).toMatchObject({ accepted: false, code: 'POSITION_INVALID' })
    const txt = join(directory, 'large.txt')
    writeFileSync(txt, 'a'.repeat(200_001))
    expect(await readUpload(home, txt)).toMatchObject({ truncated: true, nextOffset: 200_000 })
    expect(await readUpload(home, txt, { offset: 200_000 })).toMatchObject({ text: 'a', truncated: false, nextOffset: null })
  })

  it('取消后终止解析 Worker，后续读取仍可正常执行', async () => {
    const { home, directory } = fixture()
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['synthetic']]), 'Data')
    const path = join(directory, 'cancel.xlsx')
    writeFileSync(path, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const controller = new AbortController()
    const pending = readUpload(home, path, {}, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ accepted: false, code: 'FILE_PARSE_CANCELLED' })
    expect(await readUpload(home, path)).toMatchObject({ accepted: true })
  })
})
