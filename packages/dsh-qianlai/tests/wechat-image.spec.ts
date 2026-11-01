import { createDecipheriv } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { IlinkConnection } from '../src/wechat/ilink.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('微信欢迎图片协议', () => {
  it('只向微信 CDN 上传密文，并以稳定消息 id 发送可解密图片', async () => {
    const original = Buffer.from('synthetic bundled image')
    let encrypted!: Uint8Array
    let sent!: { msg: { client_id: string; item_list: { image_item: { media: { aes_key: string; encrypt_query_param: string } } }[] } }
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeDefined()
      if (String(url).endsWith('/getuploadurl')) return Response.json({ upload_param: 'synthetic' })
      if (new URL(url).hostname === 'novac2c.cdn.weixin.qq.com') {
        expect(init?.redirect).toBe('error')
        expect(init?.headers).not.toHaveProperty('Authorization')
        encrypted = init?.body as Uint8Array
        return new Response('', { headers: { 'x-encrypted-param': 'synthetic-download' } })
      }
      sent = JSON.parse(String(init?.body)) as typeof sent
      return Response.json({ message_id: 'synthetic-message' })
    }))
    const connection = new IlinkConnection('synthetic-token', async () => {})
    await connection.sendImage('synthetic-owner', undefined, original, 'welcome-image-0')
    expect(sent.msg.client_id).toBe('welcome-image-0')
    const media = sent.msg.item_list[0]!.image_item.media
    expect(media.encrypt_query_param).toBe('synthetic-download')
    const key = Buffer.from(Buffer.from(media.aes_key, 'base64').toString(), 'hex')
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(original)
  })

  it('拒绝非微信上传地址，不把失败的发送当成功', async () => {
    const network = vi.fn(async () => Response.json({ upload_full_url: 'https://example.invalid/upload' }))
    vi.stubGlobal('fetch', network)
    const connection = new IlinkConnection('synthetic-token', async () => {})
    await expect(connection.sendImage('owner', undefined, Buffer.from('test'), 'id')).rejects.toThrow('Untrusted')
    expect(network).toHaveBeenCalledTimes(1)
    network.mockImplementation(async () => Response.json({ ret: -1 }))
    await expect(connection.sendText('owner', undefined, 'test', 'stable-id')).rejects.toThrow('sendmessage')
  })
})
