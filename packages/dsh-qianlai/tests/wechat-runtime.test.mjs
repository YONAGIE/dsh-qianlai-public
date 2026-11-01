import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 使用构建后的微信入口和真正的 qrcode，在独立 Node 进程中验证原生模块解析。
// 只模拟微信网络接口，不模拟二维码库或文件系统。
const probe = String.raw`
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { apply } = await import(pathToFileURL(process.argv[1]).href)
const stateDir = process.argv[2]
let qrRequests = 0
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname
  const json = (body) => new Response(JSON.stringify(body))
  if (path.endsWith('/get_bot_qrcode')) {
    qrRequests++
    return json({ ret: 0, qrcode: 'synthetic-qr', qrcode_img_content: 'https://example.invalid/qianlai-qr' })
  }
  if (path.endsWith('/get_qrcode_status'))
    return json({ status: 'confirmed', bot_token: 'synthetic-token', ilink_bot_id: 'synthetic-bot', ilink_user_id: 'synthetic-owner' })
  if (path.endsWith('/getupdates')) return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (init.signal.aborted) fail()
    else init.signal.addEventListener('abort', fail, { once: true })
  })
  throw new Error('Unexpected request: ' + path)
}
let output = ''
const originalWrite = process.stdout.write
process.stdout.write = (chunk) => { output += String(chunk); return true }
let dispose
const messages = []
const ctx = {
  effect: (fn) => { dispose = fn() },
  on: () => () => {},
  get: () => undefined,
  logger: {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  },
  sessionController: {
    create: () => { throw new Error('No model/session should be started') },
    prompt: () => { throw new Error('No model/session should be started') },
  },
}
try {
  apply(ctx, { stateDir })
  const deadline = Date.now() + 5000
  while (!messages.includes('moneycome-wechat: connected') && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(messages.includes('moneycome-wechat: connected'), messages.join('\n'))
  const png = readFileSync(join(stateDir, 'wechat-login.png'))
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 360)
  assert.equal(png.readUInt32BE(20), 360)
  assert.ok(output.includes('\u2584') || output.includes('\u2588'), 'terminal QR must be rendered')
  const state = readFileSync(join(stateDir, 'wechat.json'), 'utf8')
  assert.equal(JSON.parse(state).botToken, 'synthetic-token')
  dispose()
  messages.length = 0
  apply(ctx, { stateDir })
  assert.ok(messages.includes('moneycome-wechat: connected'), 'saved login must reconnect')
  assert.equal(qrRequests, 1, 'saved login must not request a new QR')
  assert.equal(readFileSync(join(stateDir, 'wechat.json'), 'utf8'), state)
  process.stdout.write = originalWrite
  console.log(JSON.stringify({ pngBytes: png.length, terminalQr: true, savedLoginRestart: true }))
} finally {
  dispose?.()
  process.stdout.write = originalWrite
}
`

const require = createRequire(import.meta.url)
const qrcodeRoot = dirname(realpathSync.native(require.resolve('qrcode/package.json')))
const builtWechat = fileURLToPath(new URL('../lib/wechat/', import.meta.url))

for (const globalJunction of [false, true]) {
  test(globalJunction ? 'Windows Global junction: QR login and saved-login restart' : 'ordinary link: QR login and saved-login restart', {
    skip: globalJunction && process.platform !== 'win32',
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'qianlai-微信 路径-'))
    const link = join(root, 'node_modules', 'qrcode')
    let linked = false
    try {
      // Node 22.19 的 Windows cpSync 对本测试的目录复制有异常，逐文件复制实际运行模块。
      mkdirSync(join(root, 'wechat'))
      for (const file of ['index.js', 'ilink.js', 'control.js']) copyFileSync(join(builtWechat, file), join(root, 'wechat', file))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
      mkdirSync(dirname(link), { recursive: true })
      // 显式构造与真实 DSH 受限安装相同的重解析目标；不依赖 DSH 内部执行器。
      const target = globalJunction ? String.raw`\\?\Global` + sep + qrcodeRoot : qrcodeRoot
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      linked = true
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, join(root, 'wechat', 'index.js'), join(root, 'state')], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.equal(JSON.parse(result.stdout).savedLoginRestart, true)
    } finally {
      // Global junction 不被部分 Node 版本识别为链接；先移除链接本身，避免递归碰到依赖目标。
      if (linked) {
        if (process.platform === 'win32') rmdirSync(link)
        else unlinkSync(link)
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
}
