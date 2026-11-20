/* global window */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const dependencies = resolve(process.argv[2])
const { build } = createRequire(join(dependencies, 'package.json'))('esbuild')
const { chromium } = createRequire(new URL('../packages/dsh-qianlai/package.json', import.meta.url))('playwright-core')
const plugin = await readFile(new URL('../packages/dsh-qianlai/lib/client.js', import.meta.url), 'utf8')
const fixture = [
  "import * as React from 'react'",
  "import * as JSX from 'react/jsx-runtime'",
  "import { createRoot } from 'react-dom/client'",
  'let bundle',
  "window.__ModuleLoader__ = { load({ factory }) { bundle = factory(name => name === 'react' ? React : JSX) } }",
  plugin,
  "const sessionId = 'synthetic-next-action'",
  "const confirm = { id: 'e8e802ae-6616-45b5-98b4-1b487cc03c11', draftId: '9a78707f-f585-4aa9-b379-fd86b308c011', revision: 5, kind: 'confirm', replacesSampleBook: false }",
  'const definitions = new Map()',
  'const slots = new Map()',
  'const scope = {',
  '  effect(callback) { callback() },',
  '  sidebarRight: { commandTarget() {} }, sidebarRightTabs: { register() {} },',
  '  uiConversation: { events: { register(item) { definitions.set(item.kind, item) } } },',
  '  conversation: { async send(value) { window.lastSent = value }, input: {',
  '    canPickFiles(id) { return window.pickerEnabled && id === sessionId },',
  '    pickFiles(id) { window.pickerSession = id; document.querySelector("#intake").click() },',
  '  } },',
  '  sessions: { scope() { return { get() { return scope.conversation } } } },',
  '  connection: { rpc: { async call(_path, _method, payload) {',
  "    if (payload.action === 'card-status') return { ok: true, value: { accepted: true } }",
  "    if (payload.action === 'submit-card') return { ok: true, value: { accepted: true,",
  "      receipt: { labels: ['建档已完成'], choice: 'confirm' },",
  "      view: { completed: true, draftId: confirm.draftId, revision: 6, handoff: { kind: 'prior-period-balances', statementMonth: '2026-10', attachment: '添加科目余额表' } }",
  '    } }',
  "    throw Error('Unexpected fixture request ' + payload.action)",
  '  } } },',
  '}',
  'bundle.apply({ inject(_names, callback) { callback(scope) },',
  '  slots: { inject(_slot, mount) { mount() }, register(options, component) { slots.set(options.key ?? options.id, component) } },',
  '})',
  "const useSessions = select => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'moneycome-zhangjie' } } } })",
  "const root = createRoot(document.querySelector('main'))",
  'window.mountAction = (kind, data) => {',
  "  if (!definitions.has(kind)) throw Error('Projection not registered: ' + kind)",
  "  if (!slots.has(kind)) throw Error('Slot not registered: ' + kind)",
  '  root.render(JSX.jsx(slots.get(kind), { sessionId, useSessions, node: { data } }))',
  '}',
  "window.mountOnboarding = () => window.mountAction('moneycome-onboarding-card', confirm)",
].join('\n')
const compiled = await build({
  stdin: { contents: fixture, sourcefile: 'business-next-actions.js', resolveDir: dependencies },
  bundle: true, write: false, format: 'iife', platform: 'browser',
})
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 620 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<meta charset=utf-8><main></main><input hidden type="file" id="intake">')
  await page.addScriptTag({ content: compiled.outputFiles[0].text })
  await page.evaluate(() => { window.pickerEnabled = true; window.mountOnboarding() })
  await page.getByRole('button', { name: '确认建档', exact: true }).click()
  await page.waitForFunction(() => window.lastSent === '我已确认建档。')
  const openingFile = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加科目余额表', exact: true }).click()
  await (await openingFile).setFiles({ name: '合成交接资料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic') })
  assert.equal(await page.evaluate(() => window.pickerSession), 'synthetic-next-action')
  await page.evaluate(() => { window.pickerSession = null })
  await page.evaluate(() => {
    window.pickerEnabled = true
    window.mountAction('moneycome-invoice-upload', { action: 'replace_invoice' })
  })
  const choose = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传正确发票', exact: true }).click()
  await (await choose).setFiles({ name: '合成发票.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic') })
  assert.equal(await page.evaluate(() => window.pickerSession), 'synthetic-next-action')
  await page.evaluate(() => {
    window.pickerEnabled = false
    window.pickerSession = null
    window.mountAction('moneycome-invoice-upload', { action: 'upload_clearer_invoice' })
  })
  await page.getByRole('button', { name: '上传清晰发票', exact: true }).click()
  assert.match(await page.getByRole('status').textContent(), /拖到当前对话/)
  assert.equal(await page.evaluate(() => window.pickerSession), null)
  await page.evaluate(() => {
    window.pickerEnabled = true
    window.mountAction('moneycome-material-retry', { id: 3, name: '合成合同.pdf', code: 'FILE_FORMAT_MISMATCH' })
  })
  const retryFile = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '重新选文件', exact: true }).click()
  await (await retryFile).setFiles({ name: '合成合同重传.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic') })
  assert.equal(await page.evaluate(() => window.pickerSession), 'synthetic-next-action')
  assert.deepEqual(errors, [])
  console.log('PASS: built client mounted the next-action card, opened Chromium file chooser through session intake, and fell back when intake was unavailable')
} finally {
  await browser.close()
}
