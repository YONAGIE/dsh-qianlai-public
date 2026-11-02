// Explicit synthetic iLink transport for isolated real-DSH/real-model scenarios.
// Never loaded by the production patch or published package.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const home = process.env.E2E_WECHAT_FIXTURE_HOME
if (!home || resolve(home) !== resolve(process.env.DSH_HOME ?? '')
  || readFileSync(join(home, '.synthetic-wechat-home'), 'utf8') !== process.env.E2E_WECHAT_FIXTURE_ID)
  throw Error('WeChat fixture requires an explicit isolated test home.')
const realFetch = globalThis.fetch
let codes = 0
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url instanceof Request ? url.url : url)
  if (parsed.hostname !== 'ilinkai.weixin.qq.com') return realFetch(url, init)
  if (parsed.pathname.endsWith('/get_bot_qrcode')) return Response.json({ ret: 0, qrcode: `synthetic-${++codes}`, qrcode_img_content: `https://example.invalid/synthetic-qr-${codes}` })
  if (parsed.pathname.endsWith('/get_qrcode_status') || parsed.pathname.endsWith('/getupdates'))
    return new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' }))
      if (init?.signal?.aborted) fail()
      else init?.signal?.addEventListener('abort', fail, { once: true })
    })
  if (parsed.pathname.endsWith('/sendtyping')) return Response.json({ ret: 0 })
  throw Error('Unexpected synthetic iLink request')
}
