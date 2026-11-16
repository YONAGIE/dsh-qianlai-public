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

  it('opens a scoped choice card and saves fields directly with a value-free receipt', async () => {
    const { request, onboarding, store } = setup()
    expect(store.company()).toBeUndefined()
    const guide = onboarding.guide('test-zhangjie', 'start')
    if (!guide.accepted || !('card' in guide) || !guide.card) throw Error('Missing mode card')
    const { id: cardId, draftId, revision } = guide.card
    await expect(request('submit-card', { sessionId: 'test-zhangjie-2', cardId, draftId, revision, mode: 'scan' }))
      .resolves.toMatchObject({ accepted: false, code: 'CARD_UNAVAILABLE' })
    await expect(request('submit-card', { cardId, draftId, revision, mode: 'scan' }))
      .resolves.toMatchObject({ accepted: true, receipt: { mode: 'scan' }, view: { draftId, mode: 'scan' } })
    const fields = onboarding.guide('test-zhangjie', 'continue')
    if (!fields.accepted || !('card' in fields) || fields.card?.kind !== 'fields') throw Error('Missing fields card')
    expect(fields.card.fields.map(field => field.key)).toEqual(['companyName', 'taxId', 'taxRegion'])
    const next = { cardId: fields.card.id, draftId, revision: fields.card.revision }
    await expect(request('submit-card', { ...next, values: { startMonth: '2026-11' } }))
      .resolves.toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    await expect(request('submit-card', { ...next, values: { companyName: '合成资料企业', taxId: '000000000000000033', taxRegion: '北京市|北京市' } }))
      .resolves.toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成资料企业', province: '北京市', city: '北京市' } } })
    await expect(request('card-status', { cardId: next.cardId })).resolves.toEqual({
      accepted: true, receipt: { labels: ['企业全称', '统一社会信用代码', '税务地区'] },
    })
    await expect(request('submit-card', { ...next, values: { companyName: '不应覆盖' } }))
      .resolves.toMatchObject({ accepted: true, view: { enterprise: { companyName: '合成资料企业' } } })
    expect(store.company()).toBeUndefined()
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
