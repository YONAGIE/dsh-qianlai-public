/* global window */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
  "const sessionId = 'synthetic-business'",
  'const slots = new Map()',
  'const scope = {',
  '  effect(callback) { callback() },',
  '  sidebarRight: { commandTarget() {} }, sidebarRightTabs: { register() {} },',
  '  uiConversation: { events: { register() {} } },',
  '  conversation: { async send(value) { window.lastSent = value }, input: {} },',
  "  sessions: { scope() { return { get() { return scope.conversation } } } },",
  '  connection: { rpc: { async call(_path, method, payload) {',
  '    window.calls.push([method, payload])',
  "    if (payload.sessionId !== sessionId) throw Error('wrong session')",
  "    if (method === 'qianlai/material-archive') return { ok: true, value: { accepted: true, fileName: '合成原件.pdf', mime: 'application/pdf', base64: btoa('archived-bytes') } }",
  "    if (payload.action === 'generate') return { ok: true, value: { accepted: true, artifact: { id: 'synthetic-report', version: 1, fingerprint: 'confirmed' } } }",
  "    if (payload.action === 'download') return { ok: true, value: { accepted: true, fileName: '合成报表.xlsx', base64: btoa('report-bytes') } }",
  "    throw Error('Unexpected action: ' + payload.action)",
  '  } } },',
  '}',
  'window.calls = []',
  'bundle.apply({ inject(_names, callback) { callback(scope) },',
  '  slots: { inject(_slot, mount) { mount() }, register(options, component) { slots.set(options.key ?? options.id, component) } },',
  '})',
  "const useSessions = select => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'moneycome-zhangjie' } } } })",
  "const root = createRoot(document.querySelector('main'))",
  'window.mountAction = (kind, data) => {',
  "  if (!slots.has(kind)) throw Error('Slot not registered: ' + kind)",
  '  root.render(JSX.jsx(slots.get(kind), { sessionId, useSessions, node: { data } }))',
  '}',
].join('\n')
const compiled = await build({
  stdin: { contents: fixture, sourcefile: 'zhangjie-business.js', resolveDir: dependencies },
  bundle: true, write: false, format: 'iife', platform: 'browser',
})
const browser = await chromium.launch({ executablePath: process.env.PHASE_CHROMIUM })
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 640 }, acceptDownloads: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(8000)
  await page.setContent('<meta charset=utf-8><main></main>')
  await page.addScriptTag({ content: compiled.outputFiles[0].text })
  await page.evaluate(() => window.mountAction('moneycome-report-action', {
    accepted: true, callId: 'report-tool-turn', kind: 'financial', periodKey: '2026-10',
    fingerprint: 'confirmed', title: '合成报表', versions: [],
  }))
  await page.getByRole('button', { name: '确认生成 XLSX', exact: true }).click()
  const reportDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载第 1 版 XLSX', exact: true }).click()
  const report = await reportDownload
  assert.equal(report.suggestedFilename(), '合成报表.xlsx')
  assert.equal(await readFile(await report.path(), 'utf8'), 'report-bytes')
  await page.evaluate(() => window.mountAction('moneycome-material-archive', {
    callId: 'archive-tool-turn', matterId: 24, title: '合成事项',
    materials: [{ id: 77, name: '合成原件.pdf', downloadable: true, priorName: '旧合成原件.pdf' }],
  }))
  const archiveDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原件 合成原件.pdf', exact: true }).click()
  const archive = await archiveDownload
  assert.equal(archive.suggestedFilename(), '合成原件.pdf')
  assert.equal(await readFile(await archive.path(), 'utf8'), 'archived-bytes')
  const calls = await page.evaluate(() => window.calls)
  assert.equal(calls[0][1].fingerprint, 'confirmed')
  assert.equal(calls[1][1].id, 'synthetic-report')
  assert.equal(calls[2][1].matterId, 24)
  assert.equal(calls[2][1].materialId, 77)
  assert.deepEqual(errors, [])
  console.log('PASS: the built report and archive cards downloaded exact session-scoped artifacts in Chromium')
} finally {
  await browser.close()
}
