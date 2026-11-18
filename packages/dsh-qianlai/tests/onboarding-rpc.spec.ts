import { afterEach, describe, expect, it, vi } from 'vitest'

import { CompanyOnboarding, type OnboardingGuideAction } from '../src/company-onboarding.js'
import { companyTaxDraftAccess, registerCompanyOnboarding, type OnboardingHostServices } from '../src/onboarding-rpc.js'
import { BookStore } from '../src/store.js'
import type { RpcConnection } from '../src/wechat/control.js'

const taxDetails = {
  taxpayerIdentity: 'small-scale', taxStatus: '正常', taxAuthority: '合成主管机关',
  incomeMethod: '查账征收', accountingSystem: '小企业会计准则',
}
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const document = { name: 'synthetic.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axouYQAAAAASUVORK5CYII=' }

function setup(services: OnboardingHostServices = {}) {
  const store = new BookStore(':memory:')
  stores.push(store)
  const onboarding = new CompanyOnboarding(store)
  let handler: Parameters<RpcConnection['fetch']['register']>[0]['fetch']
  const connection: RpcConnection = { fetch: { register(route) { handler = route.fetch; return async () => {} } } }
  const sessions = {
    async inspect(id: string) {
      return { meta: { agentPreset: id.startsWith('test-zhangjie') ? 'moneycome-zhangjie' : 'default' }, events: [
        { type: 'model/selection', data: { provider: 'synthetic', model: 'vision-fixture' } },
      ] }
    },
  }
  registerCompanyOnboarding(connection, onboarding, sessions, () => services)
  async function request(action: string, extra: Record<string, unknown> = {}) {
    const response = await handler(new Request('http://localhost/api/qianlai/company-onboarding', {
      method: 'POST', body: JSON.stringify({
        type: 'client-request', method: 'qianlai/company-onboarding', rpcId: 'call',
        payload: { sessionId: 'test-zhangjie', action, ...extra },
      }),
    }))
    return (await response.json()).result.value
  }
  const card = (action: OnboardingGuideAction = 'continue', fields?: unknown, values?: unknown, mode?: unknown, documentKind?: unknown) => {
    const result = onboarding.guide('test-zhangjie', action, fields, values, mode, documentKind)
    if (!result.accepted || !('card' in result) || !result.card) throw Error('Missing onboarding card')
    return result.card
  }
  const submit = ({ id, revision, draftId }: ReturnType<typeof card>, extra: Record<string, unknown>) =>
    request('submit-card', { cardId: id, revision, draftId, ...extra })
  return { request, onboarding, store, card, submit, sessions }
}

describe('company onboarding RPC', () => {
  it('requires the host-owned Zhangjie session and current draft identity', async () => {
    const { request } = setup()
    await expect(request('status', { sessionId: 'another-preset' })).resolves.toMatchObject({ accepted: false, code: 'ONBOARDING_SESSION' })
    await expect(request('confirm', { draftId: 'other', revision: 0, replaceSampleBook: true })).resolves.toMatchObject({ accepted: false, code: 'ONBOARDING_CHANGED' })
  })

  it('recognizes only requested fields with the selected model, leaving the draft unchanged until review', async () => {
    const savedRef = { attachmentId: 'synthetic' }
    const prepareCall = vi.fn(async () => ({
      config: {}, inputModalities: ['text', 'image'],
      async *stream(options: Readonly<Record<string, unknown>>) {
        expect(options).toMatchObject({ messages: [{ content: [{ type: 'text' }, { type: 'image', attachment: savedRef }] }] })
        yield { type: 'text-delta', index: 0, text: '{' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"companyName":"虚构示例企业","establishedOn":"2024-05-10","taxpayerIdentity":"general","taxId":"unreadable"}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }))
    const { request } = setup({ llm: { prepareCall }, attachments: { async saveImage() { return savedRef } } })
    const before = await request('status')
    const result = await request('recognize', { draftId: before.draftId, revision: before.revision, kind: 'license', file: {
      name: 'synthetic.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axouYQAAAAASUVORK5CYII=',
    } })
    expect(result).toEqual({ accepted: true, fields: { companyName: '虚构示例企业', establishedOn: '2024-05-10' } })
    expect(prepareCall).toHaveBeenCalledWith({ provider: 'synthetic', model: 'vision-fixture', maxTokens: 2048 }, expect.any(AbortSignal))
    expect(await request('status')).toEqual(before)
  })

  it('continues from manual choice to its own company form and preserves a value-free receipt on reopen', async () => {
    const { request, card, submit, store } = setup()
    expect(store.company()).toBeUndefined()
    const modeCard = card('start')
    const { id: cardId, draftId, revision } = modeCard
    await expect(request('submit-card', { sessionId: 'test-zhangjie-2', cardId, draftId, revision, mode: 'manual' }))
      .resolves.toMatchObject({ accepted: false, code: 'CARD_UNAVAILABLE' })
    const choice = await submit(modeCard, { mode: 'manual' })
    expect(choice).toMatchObject({ accepted: true, receipt: { mode: 'manual' } })
    expect(choice).not.toHaveProperty('nextCard')
    const company = card('continue')
    expect(card('start')).toEqual(company)
    expect(company).toMatchObject({ kind: 'document', documentKind: 'license', fields: [
      expect.objectContaining({ key: 'companyName' }), expect.objectContaining({ key: 'taxId' }), expect.objectContaining({ key: 'establishedOn' }),
    ] })
    await expect(submit(company, { values: { startMonth: '2026-11' } }))
      .resolves.toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    const partial = await submit(company, { values: { establishedOn: '2026-01-01' } })
    expect(partial).toMatchObject({
      accepted: true, incomplete: true, card: { id: company.id, revision: company.revision + 1, fields: [
        expect.objectContaining({ key: 'companyName' }), expect.objectContaining({ key: 'taxId' }),
      ] }, view: { step: 1, enterprise: { establishedOn: '2026-01-01' } },
    })
    expect(partial).not.toHaveProperty('receipt')
    expect(card('continue')).toEqual(partial.card)
    await expect(request('card-status', { cardId: company.id })).resolves.toMatchObject({ card: partial.card })
    await expect(submit(company, { values: { establishedOn: '2026-02-01' } }))
      .resolves.toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
    await expect(submit(partial.card, { values: { companyName: '合成资料企业', taxId: '000000000000000033' } }))
      .resolves.toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成资料企业' } } })
    const receipt = await request('card-status', { cardId: company.id })
    expect(receipt).toMatchObject({ accepted: true, receipt: { labels: ['企业全称', '统一社会信用代码'] } })
    expect(receipt).not.toHaveProperty('nextCard')
    expect(card()).toMatchObject({ kind: 'document', documentKind: 'tax' })
    await expect(submit(company, { values: { companyName: '不应覆盖' } }))
      .resolves.toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成资料企业' } } })
    expect(store.company()).toBeUndefined()
  })

  it('requires all Web tax fields and specific notes under Other, while retaining partial saves', async () => {
    const { card, submit, request } = setup()
    await submit(card('start'), { mode: 'manual' })
    await submit(card(), { values: {
      companyName: '合成建档企业', taxId: '000000000000000033', establishedOn: '2026-01-01',
    } })
    const tax = card()
    if (tax.kind !== 'document') throw Error('Missing tax card')
    expect(tax.fields.map(field => field.key)).toEqual([
      'taxpayerIdentity', 'taxStatus', 'taxStatusOther', 'taxAuthority', 'incomeMethod', 'accountingSystem', 'accountingSystemOther',
    ])
    expect(tax.fields[0]?.options?.map(option => option.value)).toEqual(['small-scale', 'general'])
    expect(tax.fields[4]?.options?.map(option => option.value)).toEqual(['查账征收', '核定征收'])
    const partial = await submit(tax, { values: { taxpayerIdentity: 'small-scale', taxAuthority: taxDetails.taxAuthority } })
    expect(partial).toMatchObject({ accepted: true, incomplete: true, card: { id: tax.id } })
    expect(partial.card.message).toContain('纳税人状态')
    const another = await submit(partial.card, { values: {
      taxStatus: '其他', incomeMethod: '核定征收', accountingSystem: '其他',
    } })
    expect(another).toMatchObject({ accepted: true, incomplete: true, card: { id: tax.id } })
    expect(another.card.message).toContain('具体纳税人状态')
    expect(another.card.message).toContain('具体会计制度')
    const result = await submit(another.card, { values: {
      taxStatusOther: '合成状态说明', accountingSystemOther: '合成制度说明',
    } })
    expect(result).toMatchObject({ accepted: true, receipt: {}, view: { enterprise: {
      taxStatus: '其他', taxStatusOther: '合成状态说明', incomeMethod: '核定征收',
      accountingSystem: '其他', accountingSystemOther: '合成制度说明', province: '', city: '',
    } } })
    await expect(request('edit-section', {
      draftId: result.view.draftId, revision: result.view.revision, section: 'tax', input: { province: '北京市' },
    })).resolves.toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    expect(card()).toMatchObject({ title: '确认实际经营' })
  })

  it('previews an upload on the same card, then saves only confirmed fields', async () => {
    const prepareCall = vi.fn(async () => ({
      config: {}, inputModalities: ['text', 'image'],
      async *stream(options: Readonly<Record<string, unknown>>) {
        expect(options).toMatchObject({ messages: [{ content: [expect.objectContaining({ text: '读取这份营业执照。' }), expect.any(Object)] }] })
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"companyName":"合成执照企业","taxId":"000000000000000077"}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }))
    const { request, card, submit, onboarding } = setup({ llm: { prepareCall }, attachments: { async saveImage() { return {} } } })
    await submit(card('start'), { mode: 'manual' })
    const source = card()
    expect(source).toMatchObject({ kind: 'document', documentKind: 'license' })
    const target = { cardId: source.id, draftId: source.draftId, revision: source.revision, file: document }
    await expect(request('recognize', { ...target, sessionId: 'test-zhangjie-other' }))
      .resolves.toMatchObject({ accepted: false, code: 'CARD_UNAVAILABLE' })
    expect(prepareCall).not.toHaveBeenCalled()
    const before = await request('status')
    const preview = await request('recognize', { ...target, kind: 'tax' })
    expect(preview).toMatchObject({ accepted: true, fields: { companyName: '合成执照企业', taxId: '000000000000000077' } })
    expect(await request('status')).toEqual(before)
    await expect(submit(source, { document })).resolves.toMatchObject({ accepted: false, code: 'CARD_UNAVAILABLE' })
    const read = await submit(source, { values: { ...preview.fields, companyName: '用户核对后的合成企业' } })
    expect(read).toMatchObject({ accepted: true, incomplete: true, view: { enterprise: { companyName: '用户核对后的合成企业' } } })
    const missing = card()
    expect(missing).toMatchObject({ id: source.id, fields: [expect.objectContaining({ key: 'establishedOn' })] })
    await expect(submit(source, { values: preview.fields })).resolves.toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
    expect(prepareCall).toHaveBeenCalledTimes(1)
    const edited = await request('edit-section', {
      draftId: read.view.draftId, revision: read.view.revision, section: 'company', input: { companyName: '更正后的合成企业' },
    })
    expect(edited).toMatchObject({
      accepted: true, enterprise: { companyName: '更正后的合成企业', taxId: '000000000000000077' },
    })
    await expect(request('card-status', { cardId: missing.id })).resolves.toMatchObject({ stale: true })
    const continued = onboarding.guide('test-zhangjie', 'continue')
    expect(continued).toMatchObject({
      accepted: true, card: { draftId: read.view.draftId, revision: edited.revision },
      draftSummary: { enterprise: { companyName: '更正后的合成企业' } },
    })
    expect(JSON.stringify(continued)).not.toContain('000000000000000077')
  })

  it('does not overwrite a sidebar edit when document recognition returns late', async () => {
    let notifyStarted!: () => void
    let resumeRecognition!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const released = new Promise<void>(resolve => { resumeRecognition = resolve })
    const prepareCall = vi.fn(async () => ({
      config: {}, inputModalities: ['text', 'image'],
      async *stream() {
        notifyStarted()
        await released
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"companyName":"过期识别结果"}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }))
    const { request, card, submit } = setup({ llm: { prepareCall }, attachments: { async saveImage() { return {} } } })
    await submit(card('start'), { mode: 'manual' })
    const source = card()
    const pending = request('recognize', { cardId: source.id, draftId: source.draftId, revision: source.revision, file: document })
    await started
    try {
      await expect(request('edit-section', {
        draftId: source.draftId, revision: source.revision, section: 'company', input: { companyName: '手工核对企业' },
      })).resolves.toMatchObject({ accepted: true })
    } finally { resumeRecognition() }
    await expect(pending).resolves.toMatchObject({ accepted: false, code: 'ONBOARDING_CHANGED' })
    await expect(request('status')).resolves.toMatchObject({ enterprise: { companyName: '手工核对企业' } })
  })

  it('starts Beijing scanning with only province and city and continues after the verified profile is applied', async () => {
    const { request, card, submit, onboarding, sessions } = setup()
    const first = card('start')
    await submit(first, { mode: 'scan' })
    const region = card()
    expect(region.kind).toBe('region')
    const selectedRegion = await submit(region, { values: { province: '北京市', city: '北京市' } })
    const scan = card()
    expect(scan).toMatchObject({ kind: 'tax-scan', province: '北京市', city: '北京市', autoStart: true })
    expect(card()).toEqual(scan)
    expect(card('fill', undefined, { province: '北京市', city: '北京市' })).toEqual(scan)
    expect(selectedRegion.view.enterprise.companyName).toBe('')
    const args = { draftId: scan.draftId, cardId: scan.id, revision: scan.revision }
    await expect(request('claim-tax-auto-start', { ...args, sessionId: 'test-zhangjie-2' })).resolves.toMatchObject({ start: false })
    await expect(request('claim-tax-auto-start', { ...args, revision: region.revision })).resolves.toMatchObject({ start: false })
    await expect(request('claim-tax-auto-start', args)).resolves.toMatchObject({ start: true })
    await expect(request('claim-tax-auto-start', args)).resolves.toMatchObject({ start: false })
    const access = companyTaxDraftAccess(onboarding, sessions)
    const target = { sessionId: 'test-zhangjie', draftId: scan.draftId, province: '北京市', city: '北京市', companyName: '', taxId: '' }
    const signal = new AbortController().signal
    await expect(access.check(target, signal, region.id)).resolves.toMatchObject({ accepted: false })
    await expect(access.check(target, signal, scan.id)).resolves.toMatchObject({ accepted: true })
    await expect(access.apply(target, {
      companyName: '合成税务企业', taxId: '000000000000000055', taxpayerQualification: '小规模纳税人',
      authority: '国家税务总局北京市税务局', obligations: [], obligationCoverage: 'visible_page',
      observedAt: '2026-11-16T08:00:00.000Z', sourceUrl: 'https://example.invalid/synthetic',
    }, scan.id, signal)).resolves.toMatchObject({ accepted: true })
    await expect(request('card-status', { cardId: scan.id })).resolves.toMatchObject({
      accepted: true, receipt: { labels: ['已回填官方税务资料'] },
      view: { enterprise: { companyName: '合成税务企业', taxId: '000000000000000055' } },
    })
    expect(onboarding.guide('test-zhangjie', 'correct', ['companyName'], { companyName: '不应覆盖官方企业' }))
      .toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    expect(card()).toMatchObject({ kind: 'document', fields: [expect.objectContaining({ key: 'establishedOn' })] })
  })

  it('keeps inline company entries while switching between manual entry and scanning', async () => {
    const { request, onboarding, card, submit } = setup()
    await submit(card('start'), { mode: 'manual' })
    await submit(card(), { values: { companyName: '合成草稿企业' } })
    const region = card('switch-mode', undefined, undefined, 'scan')
    expect(region.kind).toBe('region')
    expect(onboarding.guide('test-zhangjie', 'fill', undefined, { province: '浙江省', city: '北京市' })).toMatchObject({ accepted: false })
    const scan = card('fill', undefined, { province: '北京市', city: '北京市' })
    expect(scan).toMatchObject({ kind: 'tax-scan', province: '北京市', city: '北京市', autoStart: true })
    expect(onboarding.isTaxScanCurrent('test-zhangjie', scan.draftId, scan.id)).toBe(true)
    const manual = card('switch-mode', undefined, undefined, 'manual')
    expect(onboarding.isTaxScanCurrent('test-zhangjie', scan.draftId, scan.id)).toBe(false)
    expect(manual).toMatchObject({ draftId: scan.draftId, kind: 'document', fields: [
      expect.objectContaining({ key: 'taxId' }), expect.objectContaining({ key: 'establishedOn' }),
    ] })
    await expect(request('status')).resolves.toMatchObject({ mode: 'manual', enterprise: { companyName: '合成草稿企业' } })
    expect(card('switch-mode', undefined, undefined, 'scan').kind).toBe('region')
    expect(onboarding.isTaxScanCurrent('test-zhangjie', scan.draftId, scan.id)).toBe(false)
    expect(card('fill', undefined, { province: '上海市', city: '上海市' })).toMatchObject({ kind: 'region', message: expect.stringContaining('暂未接入') })
    await expect(request('status')).resolves.toMatchObject({ mode: 'scan' })
  })

  it('keeps chat attachment extraction and typed details pending until card confirmation', async () => {
    const { request, onboarding, card, submit, store } = setup()
    await submit(card('start'), { mode: 'manual' })
    const legacy = card()
    const record = store.companyOnboarding()!
    record.cards!.at(-1)!.card = { id: legacy.id, draftId: legacy.draftId, revision: legacy.revision, kind: 'source', documentKind: 'license' }
    store.saveCompanyOnboarding(record)
    await expect(request('card-status', { cardId: legacy.id })).resolves.toMatchObject({ stale: true })
    const before = await request('status')
    const preview = card('review-document', undefined, { companyName: '合成附件企业', taxId: '000000000000000088' }, undefined, 'license')
    if (preview.kind !== 'document') throw Error('Missing document card')
    expect(preview).toMatchObject({ kind: 'document', documentKind: 'license', initialValues: { companyName: '合成附件企业', taxId: '000000000000000088' } })
    const typed = card('fill', undefined, { establishedOn: '2026-01-01' })
    if (typed.kind !== 'document') throw Error('Missing document card')
    expect(typed).toMatchObject({ initialValues: { ...preview.initialValues, establishedOn: '2026-01-01' } })
    expect(card()).toEqual(typed)
    expect(await request('status')).toEqual(before)
    expect(await submit(typed, { values: typed.initialValues })).toMatchObject({ view: { enterprise: { companyName: '合成附件企业' } } })
    expect(onboarding.guide('test-zhangjie', 'review-document', undefined, {
      companyName: '不匹配的合成企业', taxpayerIdentity: 'small-scale',
    }, undefined, 'tax')).toMatchObject({ accepted: false, code: 'DOCUMENT_SUBJECT_MISMATCH' })
    const tax = card('review-document', undefined, { taxpayerIdentity: 'small-scale' }, undefined, 'tax')
    if (tax.kind !== 'document') throw Error('Missing document card')
    expect(tax).toMatchObject({ kind: 'document', documentKind: 'tax', initialValues: { taxpayerIdentity: 'small-scale' } })
    expect(await request('status')).toMatchObject({ enterprise: { taxpayerIdentity: '' } })
    expect(await submit(tax, { values: tax.initialValues })).toMatchObject({ view: { enterprise: { taxpayerIdentity: 'small-scale' } } })
  })

  it('progresses from inline company details to final review and persists a correction before opening the book', async () => {
    const { card, submit, store } = setup()
    let active = card('start')
    const send = async (extra: Record<string, unknown>) => {
      const result = await submit(active, extra)
      if (!result.accepted) throw Error(JSON.stringify(result))
      if (!result.view.completed) active = card()
      return result
    }
    await send({ mode: 'manual' })
    await send({ values: { companyName: '合成建档企业', taxId: '000000000000000099', establishedOn: '2026-01-01' } })
    await send({ values: taxDetails })
    await send({ values: { business: ['none'] } })
    await send({ values: { bankStatus: 'none' } })
    await send({ values: { history: 'new' } })
    await send({ values: { startMonth: '2026-11' } })
    await send({ values: { payroll: 'none', social: 'none' } })
    expect(active).toMatchObject({ kind: 'confirm', replacesSampleBook: false })
    expect(store.company()).toBeUndefined()
    await send({ choice: 'edit-payroll' })
    expect(active).toMatchObject({ kind: 'fields', initialValues: { payroll: 'none', social: 'none' } })
    await send({ values: { social: 'all' } })
    expect(active).toMatchObject({ kind: 'confirm', replacesSampleBook: false })
    expect(store.company()).toBeUndefined()
    expect(await send({ choice: 'confirm' })).toMatchObject({ view: { completed: true, payroll: { social: 'all' } } })
    expect(store.company()).toMatchObject({ name: '合成建档企业', isSample: false })
  })

  it('finishes the selected correction before issuing or accepting later cards', async () => {
    const { request, onboarding, card, submit } = setup()
    await submit(card('start'), { mode: 'manual' })
    await submit(card(), { values: { companyName: '合成初始企业', taxId: '000000000000000010', establishedOn: '2026-01-01' } })
    await submit(card(), { values: taxDetails })
    const business = card()
    expect(business).toMatchObject({ title: '确认实际经营' })

    const review = card('correct', ['companyName'])
    expect(review).toMatchObject({
      title: '更正企业全称', correction: true, fields: [expect.objectContaining({ key: 'companyName' })],
      initialValues: { companyName: '合成初始企业' },
    })
    expect(card('continue', ['business'])).toEqual(review)
    await expect(submit(business, { values: { business: ['none'] } })).resolves.toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
    expect(onboarding.guide('test-zhangjie', 'fill', undefined, { taxAuthority: '不应改动' }))
      .toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    await expect(request('confirm', { draftId: review.draftId, revision: review.revision }))
      .resolves.toMatchObject({ accepted: false, code: 'DRAFT_CORRECTION_PENDING' })
    const prefilled = card('fill', undefined, { companyName: '合成更正企业' })
    expect(prefilled).toMatchObject({ initialValues: { companyName: '合成更正企业' } })
    expect(await request('status')).toMatchObject({ enterprise: { companyName: '合成初始企业' } })
    expect(card()).toEqual(prefilled)
    await expect(submit(prefilled, { values: { companyName: '合成更正企业' } })).resolves.toMatchObject({
      receipt: { notice: '已核对并保存企业全称。' }, view: { enterprise: { companyName: '合成更正企业' } },
    })
    await submit(card(), { values: { business: ['none'] } })
    await submit(card(), { values: { bankStatus: 'provided' } })
    const bank = card()
    expect(bank.kind).toBe('bank')
    await expect(request('card-status', { cardId: bank.id })).resolves.toMatchObject({ view: { enterprise: { companyName: '合成更正企业' } } })
    await expect(submit(bank, { values: {
      holder: '合成账户户名', number: '123', bank: '合成银行', currency: 'CNY',
    } })).resolves.toMatchObject({ accepted: false, code: 'BANK_NUMBER_INVALID', details: { field: 'number', index: 0 } })
    await submit(bank, { values: { holder: '合成账户户名', number: '0000000102', bank: '合成银行', currency: 'CNY' } })

    const finalReview = card('correct', ['companyName'])
    const saved = await request('edit-section', {
      draftId: finalReview.draftId, revision: finalReview.revision, section: 'company', input: { companyName: '合成侧栏更正企业' },
    })
    expect(saved).toMatchObject({
      accepted: true, enterprise: { companyName: '合成侧栏更正企业', accounts: [{ holder: '合成账户户名' }] },
    })
    expect(onboarding.guide('test-zhangjie', 'continue')).toMatchObject({
      draftSummary: { enterprise: { companyName: '合成侧栏更正企业' } }, card: { title: '确认记账准备' },
    })
  })

  it('选择有旧账后给两个月份控件，账期重叠时保留原值供更正', async () => {
    const { card, submit } = setup()
    await submit(card('start'), { mode: 'manual' })
    await submit(card(), { values: { companyName: '合成月份资料企业', taxId: '000000000000000091', establishedOn: '2026-01-01' } })
    await submit(card(), { values: taxDetails })
    await submit(card(), { values: { business: ['none'] } })
    await submit(card(), { values: { bankStatus: 'none' } })

    const history = card()
    expect(history).toMatchObject({ fields: [{ key: 'history', type: 'select' }] })
    await submit(history, { values: { history: 'previous' } })
    expect(card()).toMatchObject({ fields: [
      { key: 'lastMonth', type: 'month' }, { key: 'startMonth', type: 'month' },
    ] })
    await submit(card(), { values: { lastMonth: '2026-02', startMonth: '2026-02' } })
    expect(card()).toMatchObject({
      initialValues: { history: 'previous', lastMonth: '2026-02', startMonth: '2026-02' },
      message: expect.stringContaining('旧账已做到 2026-02'),
    })
    const correct = card('correct', ['startMonth'], { startMonth: '2026-03' })
    expect(correct).toMatchObject({ fields: [{ key: 'startMonth', type: 'month' }], initialValues: { startMonth: '2026-03' } })
    await submit(correct, { values: { startMonth: '2026-03' } })
    expect(card()).toMatchObject({ title: '确认工资社保' })
  })

  it('rejects a card issued before a newer draft revision', async () => {
    const { request, onboarding } = setup()
    const initial = await request('status')
    const { draftId } = initial
    const manual = await request('set-mode', { draftId, revision: initial.revision, mode: 'manual' })
    const draft = await request('save', { draftId, revision: manual.revision, step: 1, advance: false, input: { companyName: '第二家合成资料企业' } })
    const guide = onboarding.guide('test-zhangjie', 'continue', ['taxId'])
    if (!guide.accepted || !('card' in guide) || !guide.card) throw Error('Missing fields card')
    await request('set-mode', { draftId, revision: draft.revision, mode: 'scan' })
    await expect(request('card-status', { cardId: guide.card.id })).resolves.toMatchObject({ stale: true })
  })
})
