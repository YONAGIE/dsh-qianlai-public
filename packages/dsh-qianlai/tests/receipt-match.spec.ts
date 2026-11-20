import { describe, expect, it } from 'vitest'

import { receiptMatch } from '../src/receipt-match.js'
import { BookStore } from '../src/store.js'

const now = new Date('2026-11-20T06:00:00Z')

describe('one business with split receipts', () => {
  it('totals the receipts without treating personal collections as a company deposit', () => {
    const store = new BookStore(':memory:')
    try {
      store.createCompany({ name: '合成企业', accountingStartMonth: '2026-10', isSample: false })
      const invoiceNumber = '26660000000012345678'
      store.saveInvoice({ invoiceNumber, issueDate: '2026-11-01', direction: 'output',
        counterparty: '合成客户', totalCents: 500000n, facts: {} })
      const matter = store.createWorkMatter('分次回款', '2026-11', [])
      const material = store.saveWorkMaterial('synthetic-receipt', '合成回单.pdf', 'read', null)
      const base = { action: 'preview', matterId: matter.id, invoiceNumber, materialId: material.id,
        receiver: '合成代收人', destination: 'personal-held', paidOn: '2026-11-05' }
      const first = receiptMatch(store, { ...base, amount: '3000', reference: '合成一' }, now)
      if (!first.accepted || !('token' in first)) throw new Error(JSON.stringify(first))
      expect(receiptMatch(store, { ...base, action: 'save', token: first.token, amount: '3000', reference: '合成一' }, now)).toMatchObject({ accepted: false })
      expect(receiptMatch(store, { ...base, action: 'save', token: first.token, amount: '3000', reference: '合成一' }, now, true))
        .toMatchObject({ matched: true, remaining: '2000.00', affectsLedger: false })
      const second = receiptMatch(store, { ...base, amount: '2000', reference: '合成二' }, now)
      if (!second.accepted || !('token' in second)) throw new Error(JSON.stringify(second))
      const save = { ...base, action: 'save', token: second.token, amount: '2000', reference: '合成二' }
      expect(receiptMatch(store, save, now, true)).toMatchObject({ matched: true, amountMatched: '5000.00', remaining: '0.00' })
      expect(receiptMatch(store, save, now, true)).toMatchObject({ alreadyMatched: true, amountMatched: '5000.00' })
      expect(receiptMatch(store, { ...base, reference: '合成三', amount: '1' }, now))
        .toMatchObject({ accepted: false, code: 'RECEIPT_AMOUNT_EXCEEDS' })
      expect(store.vouchers({ periodKey: '2026-11' })).toEqual([])
    } finally {
      store.close()
    }
  })
})
