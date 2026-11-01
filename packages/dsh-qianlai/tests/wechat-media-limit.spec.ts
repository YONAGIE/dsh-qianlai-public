import { createCipheriv } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadMedia } from '../src/wechat/ilink.js'

const limit = 20 * 1024 * 1024
const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
const media = { full_url: 'https://synthetic.invalid/media', aes_key: Buffer.from(key.toString('hex')).toString('base64') }
afterEach(() => { vi.unstubAllGlobals() })
function encrypted(plain: Buffer) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}
describe('微信媒体接收边界', () => {
  it('声明超限在发出网络请求前拒绝', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(encrypted(Buffer.from('合成小文件')))))
    vi.stubGlobal('fetch', fetcher)
    await expect(downloadMedia(media, limit + 1)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('响应头声明超限时取消响应体', async () => {
    const cancel = vi.fn()
    let supplied = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (supplied) controller.close()
        else { supplied = true; controller.enqueue(new Uint8Array(16)) }
      }, cancel,
    }), { headers: { 'content-length': String(limit + 17) } })))
    await expect(downloadMedia(media)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, '16'])('长度头 %s 仍按真实流量及时截断', async header => {
    let produced = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === 24) { controller.close(); return }
        produced++
        controller.enqueue(new Uint8Array(1024 * 1024))
      }, cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: header ? { 'content-length': header } : {} })))
    await expect(downloadMedia(media)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    expect(produced).toBeLessThan(24)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('恰好20 MB保留AES填充余量，解密后内容不变', async () => {
    const plain = Buffer.alloc(limit, 65)
    const bytes = encrypted(plain)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } })))
    expect((await downloadMedia(media, plain.length)).equals(plain)).toBe(true)
  })
  it('普通中文媒体仍成功解密，并保留声明长度截取兼容', async () => {
    const plain = Buffer.from('合成中文媒体和协议尾部')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(encrypted(plain)))))
    expect(await downloadMedia(media, Buffer.byteLength('合成中文媒体'))).toEqual(Buffer.from('合成中文媒体'))
  })
  it('解密后的实际长度也有上限，不能借小声明长度隐藏额外数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(encrypted(Buffer.alloc(limit + 1, 65))))))
    await expect(downloadMedia(media, 1)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
  })
})
