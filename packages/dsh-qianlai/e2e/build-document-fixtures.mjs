// Synthetic finance files for native reader regressions. No customer material.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import * as XLSX from 'xlsx'

const save = (name, bytes) => writeFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), bytes)
const rows = [
  ['date', 'income', 'expense', 'balance', 'counterparty', 'summary'],
  ['2026-01-05', '100000.00', '', '100000.00', 'Synthetic owner', 'capital'],
  ['2026-01-18', '', '1300.00', '98700.00', 'Synthetic office vendor', 'office supplies'],
  ['2026-01-22', '20200.00', '', '118900.00', 'Synthetic client', 'service fee'],
  ['2026-01-31', '', '10.00', '118890.00', '', 'bank fee'],
]
const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Transactions')
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
  ['periodStart', '2026-01-01'], ['periodEnd', '2026-01-31'], ['openingBalance', '0.00'],
  ['incomeTotal', '120200.00'], ['expenseTotal', '1310.00'], ['closingBalance', '118890.00'],
]), 'Summary')
book.Props = { Title: 'Synthetic statement', CreatedDate: new Date('2026-01-31T00:00:00Z') }
save('stmt-jan.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
save('stmt-invalid.xlsx', 'PK\x03\x04 fake spreadsheet for the invalid-file scenario.\n')
for (const kind of ['text', 'mixed']) {
  const pdf = await PDFDocument.create()
  pdf.setCreationDate(new Date('2026-01-31T00:00:00Z'))
  pdf.setModificationDate(new Date('2026-01-31T00:00:00Z'))
  const first = pdf.addPage([800, 500])
  first.drawText('SYNTHETIC STATEMENT - January 2026', { x: 30, y: 450, size: 20 })
  if (kind === 'text') {
    rows.forEach((row, index) => first.drawText(row.join(' | '), { x: 30, y: 400 - index * 35, size: 12 }))
    first.drawText('Closing balance: 118890.00', { x: 30, y: 150, size: 16 })
  } else {
    for (let i = 0; i < 2; i++) {
      const canvas = createCanvas(760, 260)
      const context = canvas.getContext('2d')
      context.fillStyle = 'white'; context.fillRect(0, 0, 760, 260)
      context.fillStyle = 'black'; context.font = '16px sans-serif'
      const chunk = i === 0 ? rows.slice(0, 3) : rows.slice(3)
      chunk.forEach((row, index) => context.fillText(row.join(' | '), 10, 40 + index * 40))
      if (i === 1) context.fillText('Closing balance: 118890.00', 10, 180)
      const image = await pdf.embedPng(canvas.toBuffer('image/png'))
      const page = i === 0 ? first : pdf.addPage([800, 500])
      page.drawImage(image, { x: 20, y: 120, width: 760, height: 260 })
    }
  }
  save(`stmt-${kind}.pdf`, await pdf.save())
}
