import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Browser, BrowserType, LaunchOptions } from 'playwright-core'

const REQUIRE = createRequire(import.meta.url)
const LAUNCH_TIMEOUT = 15_000
const DOWNLOAD_TIMEOUT = 5 * 60_000
const DESKTOP_ENV = [
  'PATH', 'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'LOGNAME', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'SystemDrive', 'WINDIR', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
] as const

function desktopEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of DESKTOP_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function runPlaywrightNode(
  args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeout: number,
): Promise<string> {
  signal.throwIfAborted()
  const nodeEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env: nodeEnv, encoding: 'utf8', signal, timeout, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

async function ensureChromium(cacheDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  if (!isAbsolute(cacheDir)) throw new Error('Chromium 缓存目录必须是绝对路径。')
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  const cache = await realpath(cacheDir)
  const scratch = await mkdtemp(join(cache, 'download-'))
  try {
    const setupEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: cache, TMP: scratch, TEMP: scratch, TMPDIR: scratch }
    const packageFile = await realpath(REQUIRE.resolve('playwright-core/package.json'))
    const cli = join(dirname(packageFile), 'cli.js')
    // Playwright checks the cache's completion marker under its installation lock.
    await runPlaywrightNode([cli, 'install', 'chromium', '--no-shell', '--no-progress', '--no-remove'],
      setupEnv, signal, DOWNLOAD_TIMEOUT)
    const entry = await realpath(REQUIRE.resolve('playwright-core'))
    // The cache directory is read when Playwright loads. Resolve this pinned
    // version's executable in a child, keeping the DSH host environment intact.
    const executable = await runPlaywrightNode([
      '-e', 'process.stdout.write(require(process.argv[1]).chromium.executablePath())', entry,
    ], setupEnv, signal, 10_000)
    const browser = await realpath(executable)
    const fromCache = relative(cache, browser)
    if (!fromCache || fromCache === '..' || fromCache.startsWith('..' + sep) || isAbsolute(fromCache))
      throw new Error('Chromium 不在插件缓存目录中。')
    return browser
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

function launch(chromium: BrowserType, options: LaunchOptions, signal: AbortSignal): Promise<Browser> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void chromium.launch({
      ...options, headless: false, chromiumSandbox: true,
      args: ['--window-size=1360,900'], timeout: LAUNCH_TIMEOUT,
    })
      .then(browser => {
        if (signal.aborted) void browser.close().catch(() => {})
        else resolve(browser)
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function openTaxBrowser(cacheDir: string, signal: AbortSignal): Promise<Browser> {
  signal.throwIfAborted()
  const { chromium } = await import('playwright-core')
  const env = desktopEnvironment()
  for (const channel of ['msedge', 'chrome']) {
    try { return await launch(chromium, { channel, env }, signal) }
    catch { signal.throwIfAborted() }
  }

  let executablePath: string
  try { executablePath = await ensureChromium(cacheDir, env, signal) }
  catch {
    signal.throwIfAborted()
    throw new Error('下载用于税务建档的 Chromium 失败。请检查网络和 DSH 数据目录权限后重试。')
  }
  try { return await launch(chromium, { executablePath, env }, signal) }
  catch {
    signal.throwIfAborted()
    throw new Error('无法启动税务建档浏览器。请检查运行 DSH 的电脑及浏览器所需系统组件。')
  }
}
