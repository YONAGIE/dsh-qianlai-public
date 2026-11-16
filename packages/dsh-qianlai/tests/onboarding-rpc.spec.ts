import { afterEach, describe, expect, it, vi } from 'vitest'

import { CompanyOnboarding } from '../src/company-onboarding.js'
import { registerCompanyOnboarding, type OnboardingHostServices } from '../src/onboarding-rpc.js'
import { BookStore } from '../src/store.js'
import type { RpcConnection } from '../src/wechat/control.js'

const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup(services: OnboardingHostServices = {}) {
  const store = new BookStore(':memory:')
  stores.push(store)
  const onboarding = new CompanyOnboarding(store)
  let handler: Parameters<RpcConnection['fetch']['register']>[0]['fetch']
  const connection: RpcConnection = { fetch: { register(route) { handler = route.fetch; return async () => {} } } }
  registerCompanyOnboarding(connection, onboarding, {
    async inspect(id) {
      return { meta: { agentPreset: id.startsWith('test-zhangjie') ? 'moneycome-zhangjie' : 'default' }, events: [
        { type: 'model/selection', data: { provider: 'synthetic', model: 'vision-fixture' } },
      ] }
    },
  }, () => services)
  async function request(action: string, extra: Record<string, unknown> = {}) {
    const response = await handler(new Request('http://localhost/api/qianlai/company-onboarding', {
      method: 'POST', body: JSON.stringify({
        type: 'client-request', method: 'qianlai/company-onboarding', rpcId: 'call',
        payload: { sessionId: 'test-zhangjie', action, ...extra },
      }),
    }))
    return (await response.json()).result.value
  }
  return { request, onboarding, store }
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
    const { request, onboarding, store } = setup()
    expect(store.company()).toBeUndefined()
    const guide = onboarding.guide('test-zhangjie', 'start')
    if (!guide.accepted || !('card' in guide) || !guide.card) throw Error('Missing mode card')
    const { id: cardId, draftId, revision } = guide.card
    await expect(request('submit-card', { sessionId: 'test-zhangjie-2', cardId, draftId, revision, mode: 'manual' }))
      .resolves.toMatchObject({ accepted: false, code: 'CARD_UNAVAILABLE' })
    const choice = await request('submit-card', { cardId, draftId, revision, mode: 'manual' })
    expect(choice).toMatchObject({ accepted: true, receipt: { mode: 'manual' }, nextCard: { kind: 'source', documentKind: 'license' } })
    const source = await request('submit-card', { cardId: choice.nextCard.id, draftId, revision: choice.nextCard.revision, choice: 'manual' })
    expect(source.nextCard.fields.map((field: { key: string }) => field.key)).toEqual(['companyName', 'taxId', 'establishedOn'])
    const next = { cardId: source.nextCard.id, draftId, revision: source.nextCard.revision }
    await expect(request('submit-card', { ...next, values: { startMonth: '2026-11' } }))
      .resolves.toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    await expect(request('submit-card', { ...next, values: { companyName: '合成资料企业', taxId: '000000000000000033' } }))
      .resolves.toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成资料企业' } },
        nextCard: { kind: 'fields', fields: [expect.objectContaining({ key: 'establishedOn' })] } })
    await expect(request('card-status', { cardId: next.cardId })).resolves.toMatchObject({
      accepted: true, receipt: { labels: ['企业全称', '统一社会信用代码'] }, nextCard: { kind: 'fields' },
    })
    await expect(request('submit-card', { ...next, values: { companyName: '不应覆盖' } }))
      .resolves.toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成资料企业' } } })
    expect(store.company()).toBeUndefined()
  })

  it('uses the upload card to recognize directly and asks only for remaining company fields', async () => {
    const prepareCall = vi.fn(async () => ({
      config: {}, inputModalities: ['text', 'image'],
      async *stream() {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"companyName":"合成执照企业","taxId":"000000000000000077"}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }))
    const { request, onboarding } = setup({ llm: { prepareCall }, attachments: { async saveImage() { return {} } } })
    const root = onboarding.guide('test-zhangjie', 'start')
    if (!root.accepted || !('card' in root) || !root.card) throw Error('Missing mode card')
    const send = (card: { id: string; revision: number }, extra: Record<string, unknown>) => request('submit-card', {
      cardId: card.id, revision: card.revision, draftId: root.card!.draftId, ...extra,
    })
    const choice = await send(root.card, { mode: 'manual' })
    const file = await send(choice.nextCard, { choice: 'license' })
    expect(file.nextCard).toMatchObject({ kind: 'upload', documentKind: 'license' })
    const document = { name: 'synthetic.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axouYQAAAAASUVORK5CYII=' }
    const read = await send(file.nextCard, { document })
    expect(read).toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成执照企业' } },
      nextCard: { fields: [expect.objectContaining({ key: 'establishedOn' })] } })
    await send(file.nextCard, { document })
    expect(prepareCall).toHaveBeenCalledTimes(1)
  })

  it('starts Beijing scanning with only province and city and continues after the verified profile is applied', async () => {
    const { request, onboarding } = setup()
    const root = onboarding.guide('test-zhangjie', 'start')
    if (!root.accepted || !('card' in root) || !root.card) throw Error('Missing mode card')
    const { id, draftId, revision } = root.card
    const selected = await request('submit-card', { cardId: id, draftId, revision, mode: 'scan' })
    expect(selected.nextCard.kind).toBe('region')
    const selectedRegion = await request('submit-card', { cardId: selected.nextCard.id, draftId, revision: selected.nextCard.revision,
      values: { province: '北京市', city: '北京市' } })
    expect(selectedRegion.nextCard).toMatchObject({ kind: 'tax-scan', province: '北京市', city: '北京市' })
    expect(selectedRegion.view.enterprise.companyName).toBe('')
    expect(onboarding.applyTaxProfile(draftId, '北京市', '北京市', {
      companyName: '合成税务企业', taxId: '000000000000000055', taxpayerQualification: '小规模纳税人',
      authority: '国家税务总局北京市税务局', obligations: [], obligationCoverage: 'visible_page',
      observedAt: '2026-11-16T08:00:00.000Z', sourceUrl: 'https://example.invalid/synthetic',
    }, selectedRegion.nextCard.id)).toMatchObject({ accepted: true })
    await expect(request('card-status', { cardId: selectedRegion.nextCard.id })).resolves.toMatchObject({
      accepted: true, receipt: { labels: ['已回填官方税务资料'] },
      nextCard: { kind: 'fields', fields: [expect.objectContaining({ key: 'establishedOn' })] },
      view: { enterprise: { companyName: '合成税务企业', taxId: '000000000000000055' } },
    })
  })

  it('keeps inline company entries while switching between manual entry and scanning', async () => {
    const { request, onboarding } = setup()
    const root = onboarding.guide('test-zhangjie', 'start')
    if (!root.accepted || !('card' in root) || !root.card) throw Error('Missing mode card')
    const send = (card: { id: string; revision: number }, extra: Record<string, unknown>) => request('submit-card', {
      cardId: card.id, revision: card.revision, draftId: root.card!.draftId, ...extra,
    })
    const started = await send(root.card, { mode: 'manual' })
    const form = await send(started.nextCard, { choice: 'manual' })
    expect(form.nextCard.canSwitchToScan).toBe(true)
    const scan = await send(form.nextCard, { choice: 'scan', values: { companyName: '合成草稿企业' } })
    expect(scan).toMatchObject({ view: { enterprise: { companyName: '合成草稿企业' } }, nextCard: { kind: 'region' } })
    const manual = await send(scan.nextCard, { choice: 'manual' })
    expect(manual).toMatchObject({ view: { enterprise: { companyName: '合成草稿企业' } }, nextCard: { kind: 'fields' } })
    expect(manual.nextCard.fields.map((field: { key: string }) => field.key)).toEqual(['taxId', 'establishedOn'])
  })

  it('progresses from inline company details to final review and persists a correction before opening the book', async () => {
    const { request, onboarding, store } = setup()
    const root = onboarding.guide('test-zhangjie', 'start')
    if (!root.accepted || !('card' in root) || !root.card) throw Error('Missing mode card')
    let card = root.card
    const send = async (extra: Record<string, unknown>) => {
      const result = await request('submit-card', { cardId: card.id, revision: card.revision, draftId: card.draftId, ...extra })
      if (!result.accepted) throw Error(JSON.stringify(result))
      card = result.nextCard
      return result
    }
    await send({ mode: 'manual' })
    await send({ choice: 'manual' })
    await send({ values: { companyName: '合成建档企业', taxId: '000000000000000099', establishedOn: '2026-01-01' } })
    await send({ choice: 'manual' })
    await send({ values: { taxpayerIdentity: 'small-scale' } })
    await send({ values: { business: ['none'] } })
    await send({ values: { bankStatus: 'none' } })
    await send({ values: { history: 'new', startMonth: '2026-11' } })
    await send({ values: { payroll: 'none', social: 'none' } })
    expect(card.kind).toBe('confirm')
    expect(store.company()).toBeUndefined()
    await send({ choice: 'edit-payroll' })
    expect(card).toMatchObject({ kind: 'fields', initialValues: { payroll: 'none', social: 'none' } })
    await send({ values: { social: 'all' } })
    expect(card.kind).toBe('confirm')
    expect(store.company()).toBeUndefined()
    expect(await send({ choice: 'confirm' })).toMatchObject({ view: { completed: true, payroll: { social: 'all' } } })
    expect(store.company()).toMatchObject({ name: '合成建档企业' })
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
