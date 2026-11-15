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
      return { meta: { agentPreset: id === 'test-zhangjie' ? 'moneycome-zhangjie' : 'default' }, events: [
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
  return { request }
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
})
