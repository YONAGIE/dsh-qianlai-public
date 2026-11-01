import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 真实 DSH 安装/启动冒烟测试；只替换微信网络，不扫码、不调用模型。
// 参数为已安装 DSH 的 lib/bin.js；桌面内置 CLI 可通过环境变量指定执行程序。
const cli = resolve(process.argv[2])
const executable = process.env.QIANLAI_DSH_EXECUTABLE || process.execPath
const prefix = process.env.QIANLAI_DSH_EXECUTABLE ? ['--expose-internals', cli] : [cli]
const plugin = process.env.QIANLAI_DSH_PLUGIN_PATH
  ? resolve(process.env.QIANLAI_DSH_PLUGIN_PATH)
  : fileURLToPath(new URL('../', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'qianlai-dsh-wechat-'))
const home = join(root, 'home')
const marker = join(root, 'requests.jsonl')
const preload = join(root, 'fake-ilink.mjs')
writeFileSync(marker, '')
writeFileSync(preload, `
import { appendFileSync } from 'node:fs'
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url instanceof Request ? url.url : url)
  if (parsed.hostname !== 'ilinkai.weixin.qq.com') return originalFetch(url, init)
  const path = parsed.pathname
  appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ path, node: process.version }) + '\\n')
  const json = (body) => new Response(JSON.stringify(body))
  if (path.endsWith('/get_bot_qrcode'))
    return json({ ret: 0, qrcode: 'synthetic-qr', qrcode_img_content: 'https://example.invalid/qianlai-qr' })
  if (path.endsWith('/get_qrcode_status'))
    return json({ status: 'confirmed', bot_token: 'synthetic-token', ilink_bot_id: 'synthetic-bot', ilink_user_id: 'synthetic-owner' })
  if (path.endsWith('/getupdates')) return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (init.signal.aborted) fail()
    else init.signal.addEventListener('abort', fail, { once: true })
  })
  throw new Error('Unexpected WeChat request: ' + path)
}
`)
const env = { ...process.env, DSH_HOME: home, MONEYCOME_WECHAT: '1' }
// 不从开发机器继承真实模型凭据。
delete env.DEEPSEEK_API_KEY
delete env.DEEPSEEK_BASE_URL
if (process.env.QIANLAI_DSH_EXECUTABLE) env.ELECTRON_RUN_AS_NODE = '1'
const requests = () => readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const paths = () => requests().map((request) => request.path)
const count = (ending) => paths().filter((path) => path.endsWith(ending)).length

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    child.once('close', resolve)
    child.kill()
  })
}

async function install() {
  const child = spawn(executable, [...prefix, 'plugin', '--profile', 'web', 'add', `link:${plugin}`], { env, windowsHide: true })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const timer = setTimeout(() => child.kill(), 240_000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 0, output)
  } finally {
    clearTimeout(timer)
    await stop(child)
  }
}

async function boot(savedLogin) {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  const beforeUpdates = count('/getupdates')
  const child = spawn(executable, [...prefix, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim() }, windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  let spawnError
  child.on('error', (error) => { spawnError = error })
  try {
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
      if (count('/getupdates') > beforeUpdates) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })
          // 隔离宿主也会要求网页登录；401 同样说明网页服务已就绪。
          ready = response.ok || response.status === 401
        } catch { /* 等待网页服务就绪。 */ }
        if (ready && (savedLogin || output.includes('微信已接上'))) break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ifError(spawnError)
    assert.ok(ready && count('/getupdates') > beforeUpdates, output)
    assert.doesNotMatch(output, /did not activate|failed to import|moneycome-wechat: login failed/)
    const png = readFileSync(join(home, 'moneycome', 'wechat-login.png'))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    if (!savedLogin) assert.match(output, /[▄█]/, 'terminal QR must be rendered')
    assert.equal(count('/get_bot_qrcode'), 1, 'saved login must not request a new QR')
    assert.equal(JSON.parse(readFileSync(join(home, 'moneycome', 'wechat.json'), 'utf8')).botToken, 'synthetic-token')
    console.log(`PASS: real DSH ${savedLogin ? 'saved-login restart' : 'plugin install, activation and QR login'} (${process.platform}, host Node ${requests()[0].node})`)
  } finally {
    await stop(child)
  }
}

try {
  await install()
  await boot(false)
  await boot(true)
} finally {
  // pnpm 创建的是正常链接；不清理插件源目录和用户的真实 DSH_HOME。
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
