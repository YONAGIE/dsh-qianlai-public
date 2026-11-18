import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { openTaxBrowser } from '../src/tax-browser.js'

const { launch, execFile } = vi.hoisted(() => ({ launch: vi.fn(), execFile: vi.fn() }))
vi.mock('playwright-core', () => ({ chromium: { launch } }))
vi.mock('node:child_process', () => ({ execFile }))

const roots: string[] = []
function cacheDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianlai-tax-browser-'))
  roots.push(root)
  return join(root, 'chromium')
}
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('uses installed Edge first without invoking the installer', async () => {
  const browser = { close: vi.fn() }
  launch.mockResolvedValueOnce(browser)
  await expect(openTaxBrowser(cacheDir(), new AbortController().signal)).resolves.toBe(browser)
  expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    channel: 'msedge', headless: false, chromiumSandbox: true, args: ['--window-size=1360,900'],
  }))
  expect(execFile).not.toHaveBeenCalled()
})

it('tries installed Chrome after Edge fails', async () => {
  const browser = { close: vi.fn() }
  launch.mockRejectedValueOnce(Error('Edge unavailable')).mockResolvedValueOnce(browser)
  await expect(openTaxBrowser(cacheDir(), new AbortController().signal)).resolves.toBe(browser)
  expect(launch.mock.calls.map(([options]) => options.channel)).toEqual(['msedge', 'chrome'])
  expect(execFile).not.toHaveBeenCalled()
})

it('downloads the pinned Chromium into the plugin cache and launches the matching executable', async () => {
  const browser = { close: vi.fn() }
  const cache = cacheDir()
  const executable = join(cache, 'chromium-1234', 'chrome-synthetic')
  const commands: string[][] = []
  launch.mockRejectedValueOnce(Error('Edge unavailable')).mockRejectedValueOnce(Error('Chrome unavailable')).mockResolvedValueOnce(browser)
  vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', 'external-playwright-cache')
  vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-host-secret')
  execFile.mockImplementation((_node: string, args: string[], options: { env: NodeJS.ProcessEnv },
    done: (error: Error | null, stdout: string) => void) => {
    commands.push(args)
    expect(options.env.PLAYWRIGHT_BROWSERS_PATH).toBe(realpathSync.native(cache))
    expect(options.env.DEEPSEEK_API_KEY).toBeUndefined()
    if (args[1] === 'install') {
      mkdirSync(join(cache, 'chromium-1234'))
      writeFileSync(executable, 'synthetic executable')
      done(null, '')
    } else done(null, executable)
  })

  await expect(openTaxBrowser(cache, new AbortController().signal)).resolves.toBe(browser)
  expect(commands).toHaveLength(2)
  expect(basename(commands[0]![0]!)).toBe('cli.js')
  expect(commands[0]!.slice(1)).toEqual(['install', 'chromium', '--no-shell', '--no-progress', '--no-remove'])
  expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({
    executablePath: await realpath(executable), headless: false, chromiumSandbox: true,
  }))
  expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe('external-playwright-cache')
  expect(readdirSync(cache)).toEqual(['chromium-1234'])
})

it('closes a browser that finishes launching after the operation was cancelled', async () => {
  const browser = { close: vi.fn(async () => {}) }
  const controller = new AbortController()
  const reason = Error('cancelled')
  let finish!: (value: typeof browser) => void
  launch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const opening = openTaxBrowser(cacheDir(), controller.signal)
  const outcome = expect(opening).rejects.toBe(reason)
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  controller.abort(reason)
  await outcome
  finish(browser)
  await vi.waitFor(() => expect(browser.close).toHaveBeenCalledOnce())
  expect(launch).toHaveBeenCalledOnce()
  expect(execFile).not.toHaveBeenCalled()
})

it('cancels fallback installation and cleans its temporary directory', async () => {
  const cache = cacheDir()
  const controller = new AbortController()
  const reason = Error('cancelled')
  launch.mockRejectedValue(Error('Browser unavailable'))
  execFile.mockImplementation((_node: string, _args: string[], options: { signal: AbortSignal },
    done: (error: Error) => void) => {
    options.signal.addEventListener('abort', () => done(Error('child cancelled')), { once: true })
  })
  const opening = openTaxBrowser(cache, controller.signal)
  const outcome = expect(opening).rejects.toBe(reason)
  await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce())
  controller.abort(reason)
  await outcome
  expect(launch).toHaveBeenCalledTimes(2)
  expect(readdirSync(cache)).toEqual([])
})
