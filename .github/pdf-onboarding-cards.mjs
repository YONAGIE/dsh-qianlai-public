import assert from 'node:assert/strict'

export const fields = {
  license: { companyName: '合成主线验收企业', taxId: '000000000000000199', establishedOn: '2025-01-08' },
  tax: { taxpayerIdentity: 'small-scale', taxStatus: '正常', taxAuthority: '合成主管税务机关',
    incomeMethod: '查账征收', accountingSystem: '小企业会计准则' },
  bank: { holder: '合成主线验收企业', number: '000000000000006789', bank: '合成银行支行', currency: 'CNY' },
}

export async function completeOnboarding(onboarding, turn, pdfLib) {
  const current = async (kind, documentKind) => {
    const reply = await onboarding('open-entry', { turn })
    assert.equal(reply.accepted, true, JSON.stringify(reply))
    assert.equal(reply.card?.kind, kind, JSON.stringify(reply))
    if (documentKind) assert.equal(reply.card.documentKind, documentKind)
    return reply.card
  }
  const key = card => ({ cardId: card.id, draftId: card.draftId, revision: card.revision })
  const submit = async (card, data) => {
    const result = await onboarding('submit-card', { ...key(card), ...data })
    assert.equal(result.accepted, true, JSON.stringify(result))
    return result.view
  }
  async function document(kind, card) {
    const pdf = await pdfLib.PDFDocument.create()
    pdf.addPage().drawText('SyntheticAcceptance:' + kind + ' isolated workflow verification')
    const file = { name: kind + '-synthetic.pdf', mimeType: 'application/pdf', base64: Buffer.from(await pdf.save()).toString('base64') }
    const recognized = await onboarding('recognize', { ...key(card), file })
    assert.equal(recognized.accepted, true, kind + ': ' + JSON.stringify(recognized))
    assert.deepEqual(recognized.fields, fields[kind])
    return recognized.fields
  }
  const license = await current('document', 'license')
  const licenseFields = await document('license', license)
  const before = await onboarding('status')
  assert.notEqual(before.enterprise?.companyName, licenseFields.companyName)
  assert.equal((await submit(license, { values: licenseFields })).enterprise.companyName, licenseFields.companyName)

  const tax = await current('document', 'tax')
  const taxFields = await document('tax', tax)
  assert.equal((await submit(tax, { values: taxFields })).enterprise.taxStatus, taxFields.taxStatus)
  await submit(await current('fields'), { values: { business: ['none'] } })
  await submit(await current('fields'), { values: { bankStatus: 'provided' } })
  const bank = await current('bank')
  assert.equal((await submit(bank, { values: await document('bank', bank) })).enterprise.accounts[0].maskedNumber, '尾号 6789')
  await submit(await current('bank-next'), { choice: 'continue' })
  await submit(await current('fields'), { values: { history: 'previous' } })
  await submit(await current('fields'), { values: { lastMonth: '2026-09', startMonth: '2026-10' } })
  const payroll = await current('fields')
  const available = Object.fromEntries(payroll.fields.map(({ key }) => [key, true]))
  if (available.payday) {
    await submit(payroll, { values: { payroll: 'scheduled', social: 'partial', payday: '9' } })
  } else {
    await submit(payroll, { values: { payroll: 'scheduled', social: 'partial' } })
    await submit(await current('fields'), { values: { payday: '9' } })
  }
  const view = await submit(await current('confirm'), { choice: 'confirm' })
  assert.equal(view.completed, true)
  assert.equal(view.accounting.startMonth, '2026-10')
  assert.equal(view.payroll.payday, 9)
  assert.equal(view.handoff.kind, 'prior-period-balances')
  assert.equal((await onboarding('entry-status', { turn })).entry, null)
  console.log('PASS: three regenerated PDFs through actual DSH recognition, preview vs saved fields, verified account, full onboarding and opening-balance handoff')
}
