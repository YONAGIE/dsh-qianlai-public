/* global window, document, getComputedStyle */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const [uiDependencies, evidence] = process.argv.slice(2)
const requireUI = createRequire(join(resolve(uiDependencies), 'package.json'))
const { build } = requireUI('esbuild')
const requirePlugin = createRequire(new URL('../packages/dsh-qianlai/package.json', import.meta.url))
const { chromium } = requirePlugin('playwright-core')
const plugin = await readFile(new URL('../packages/dsh-qianlai/lib/client.js', import.meta.url), 'utf8')
await mkdir(evidence, { recursive: true })

const fixture = [
  "import * as React from 'react'",
  "import * as JSX from 'react/jsx-runtime'",
  "import { createRoot } from 'react-dom/client'",
  'let bundle',
  'window.__ModuleLoader__ = { load({ factory }) {',
  "  bundle = factory(name => name === 'react' ? React : JSX)",
  '} }',
  plugin,
  "const sessionId = 'synthetic-browser'",
  "const draftId = '9a78707f-f585-4aa9-b379-fd86b308c011'",
  "const syntheticCard = { id: 'e8e802ae-6616-45b5-98b4-1b487cc03c11', draftId, revision: 1,",
  "  kind: 'document', documentKind: 'license', fields: [",
  "    { key: 'companyName', label: '企业全称', type: 'text' },",
  "    { key: 'taxId', label: '统一社会信用代码', type: 'text' },",
  "    { key: 'establishedOn', label: '成立日期', type: 'date' },",
  '  ] }',
  "const card = window.fixtureMode === 'required-date' ? { ...syntheticCard, kind: 'fields', fields: [syntheticCard.fields[2]] } : syntheticCard",
  "const view = { draftId, revision: 1, step: 1, mode: 'manual', completed: false,",
  "  enterprise: { companyName: '', taxId: '', establishedOn: '', business: [], bankStatus: 'provided',",
  "    accounts: [{ id: 'synthetic-bank', holder: '合成测试有限公司', bank: '合成银行', currency: 'CNY', openedOn: '' }] },",
  "  accounting: { history: 'previous', lastMonth: '2024-11', startMonth: '2024-12' }, payroll: {} }",
  'const slots = new Map()',
  'const scope = {',
  '  effect(callback) { callback() },',
  "  sessions: { scope: () => ({ get: () => ({ send: async () => {} }) }) },",
  '  sidebarRight: {}, sidebarRightTabs: { register() {} },',
  '  uiConversation: { events: { register() {} } },',
  '  connection: { rpc: { async call(_path, _method, payload) {',
  '    const ok = value => ({ ok: true, value: { accepted: true, ...value } })',
  "    if (payload.action === 'status') return ok(view)",
  "    if (payload.action === 'card-status') return ok({ card, view })",
  "    if (payload.action === 'recognize') {",
  '      window.recognitionCalls.push(payload.file.name)',
  '      return ok(await new Promise(resolve => { window.finishRecognition = resolve }))',
  '    }',
  "    if (payload.action === 'submit-card') {",
  '      window.submission = payload.values',
  '      Object.assign(view.enterprise, payload.values)',
  '      view.revision++',
  "      return ok({ receipt: { labels: ['企业资料'] }, view: structuredClone(view) })",
  '    }',
  "    if (payload.action === 'edit-section') {",
  '      window.sidebarSave = payload.input',
  "      Object.assign(payload.section === 'company' ? view.enterprise : view.accounting, payload.input)",
  '      view.revision++',
  '      return ok(structuredClone(view))',
  '    }',
  "    throw Error('Unexpected fixture request: ' + payload.action)",
  '  } } },',
  '}',
  'window.recognitionCalls = []',
  'bundle.apply({ inject(_names, callback) { callback(scope) },',
  '  slots: { inject(_slot, mount) { mount() }, register(options, component) { slots.set(options.key ?? options.id, component) } },',
  '})',
  "const useSessions = select => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'moneycome-zhangjie' } } } })",
  "createRoot(document.querySelector('#left')).render(JSX.jsx(slots.get('moneycome-onboarding-card'), { sessionId, useSessions, node: { data: card } }))",
  "createRoot(document.querySelector('#right')).render(JSX.jsx(slots.get('moneycome-onboarding'), { sessionId, useSessions }))",
].join('\n')
const result = await build({
  stdin: { contents: fixture, sourcefile: 'onboarding-interactions.js', resolveDir: resolve(uiDependencies) },
  platform: 'browser', bundle: true, write: false, minify: false, format: 'iife',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
const browser = await chromium.launch()
const content = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>' +
  ':root{--dsw-alias-label-primary:#22362b;--dsw-alias-label-secondary:#53685c;--dsw-alias-fill-primary:#fff;' +
  '--dsw-alias-background-primary:#fff;font:16px/1.5 system-ui,sans-serif}' +
  'body{margin:0;background:#f2f5f3;color:#22362b}main{display:grid;grid-template-columns:54% 46%;height:100vh;min-width:0}' +
  '#left{padding:23px;overflow:auto}#right{min-width:0;background:white;border-left:1px solid #dbe5df}' +
  '@media(max-width:650px){main{grid-template-columns:1fr}#left{padding:10px}#right{display:none}}</style>' +
  '<main><section id="left"></section><aside id="right"></aside></main></html>'

const page = await browser.newPage({ viewport: { width: 1260, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(7000)
const left = page.locator('#left')
const right = page.locator('#right')
const dialog = page.getByRole('dialog')
const screenshot = name => page.screenshot({ path: join(evidence, name + '.png') })

async function mount(mode = '') {
  await page.goto('about:blank')
  // Even when the URL is identical, discard the old React roots and RPC fixture.
  await page.reload()
  await page.setContent(content)
  await page.evaluate(mode => { window.fixtureMode = mode }, mode)
  await page.addScriptTag({ content: result.outputFiles[0].text })
  await left.getByRole('button', { name: /^成立日期，/ }).waitFor()
}

try {
  await mount()
  const leftDate = left.getByRole('button', { name: /^成立日期，/ })
  const rightDate = right.getByRole('button', { name: /^成立日期，/ })
  const rightMonth = right.getByRole('button', { name: /^开始记账的月份，/ })
  await leftDate.click()
  await dialog.getByRole('button', { name: '跳到年份' }).click()
  const leapYear = dialog.getByRole('button', { name: '2016 年', exact: true })
  for (let i = 0; i < 12 && !await leapYear.isVisible(); i++) {
    await dialog.getByRole('button', { name: '上一组年份' }).click()
  }
  await leapYear.click()
  await dialog.getByRole('button', { name: '跳到月份' }).click()
  await dialog.getByRole('button', { name: '2 月', exact: true }).click()
  await screenshot('calendar-day')
  await dialog.getByRole('button', { name: '2016 年 2 月 29 日', exact: true }).click()
  assert.match(await leftDate.textContent(), /2016 年 2 月 29 日/)
  assert.match(await rightDate.textContent(), /选择日期/)
  await left.getByRole('button', { name: '保存到草稿' }).click()
  assert.deepEqual(await page.evaluate(() => window.submission), { establishedOn: '2016-02-29' })
  await right.getByRole('button', { name: '成立日期，2016 年 2 月 29 日', exact: true }).waitFor()

  await rightDate.click()
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === '2016 年 2 月 29 日')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '2016 年 2 月 28 日')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '成立日期，2016 年 2 月 29 日')
  await rightDate.click()
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === '2016 年 2 月 29 日')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await right.getByRole('form', { name: '公司资料' }).getByRole('button', { name: '保存', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.sidebarSave), { establishedOn: '2016-02-28' })
  await right.getByRole('button', { name: /^开户日期，/ }).click()
  assert.equal(await dialog.getByRole('button', { name: '今天' }).isVisible(), true)
  await page.keyboard.press('Escape')
  await rightMonth.click()
  assert.equal(await dialog.getByRole('button', { name: '10 月', exact: true }).isDisabled(), true)
  await dialog.getByRole('button', { name: '下一年' }).click()
  await screenshot('calendar-month')
  await dialog.getByRole('button', { name: '2 月', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await right.locator('input[name="startMonth"]').inputValue(), '2025-02')
  console.log('PASS: leap day, year/month jumps, keyboard, FormData, sidebar save and month bounds')

  await page.setViewportSize({ width: 390, height: 650 })
  await mount('required-date')
  await left.getByRole('button', { name: '保存到草稿' }).click()
  assert.equal(await left.getByRole('alert').textContent(), '请选择成立日期。')
  await leftDate.click()
  const frame = await dialog.boundingBox()
  assert.ok(frame.x >= 0 && frame.x + frame.width <= 390 && frame.y >= 0 && frame.y + frame.height <= 651)
  await dialog.getByRole('button', { name: '今天' }).click()
  await left.getByRole('button', { name: '保存到草稿' }).click()
  assert.match(await page.evaluate(() => window.submission.establishedOn), /^\d{4}-\d{2}-\d{2}$/)
  console.log('PASS: required-field message and narrow calendar bounds')

  await page.setViewportSize({ width: 1260, height: 900 })
  await mount()
  const fileChooser = page.waitForEvent('filechooser')
  await left.getByRole('button', { name: '选择营业执照' }).click()
  await (await fileChooser).setFiles({
    name: '合成营业执照.png', mimeType: 'image/png', buffer: Buffer.from('synthetic-image'),
  })
  const reading = left.locator('[data-qianlai-document-file="reading"]')
  await reading.getByText('合成营业执照.png').waitFor()
  await reading.getByText('读取中', { exact: true }).waitFor()
  await page.waitForFunction(() => typeof window.finishRecognition === 'function')
  assert.equal(await left.getByRole('button', { name: '保存到草稿' }).isDisabled(), true)
  await left.getByRole('textbox', { name: '企业全称' }).fill('手填的合成测试有限公司')
  const spinner = reading.locator('.qianlai-document-reading')
  assert.equal(await spinner.evaluate(node => getComputedStyle(node, '::before').animationName), 'qianlai-document-spin')
  await screenshot('file-reading')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await spinner.evaluate(node => getComputedStyle(node, '::before').animationName), 'none')
  await page.evaluate(() => window.finishRecognition({ accepted: false, code: 'DOCUMENT_RECOGNITION_FAILED', message: '暂时未能读出，请重试。' }))
  const failed = left.locator('[data-qianlai-document-file="error"]')
  assert.equal(await failed.getByRole('alert').textContent(), '暂时未能读出，请重试。')
  await screenshot('file-retry')
  assert.equal(await left.getByRole('textbox', { name: '企业全称' }).inputValue(), '手填的合成测试有限公司')
  await failed.getByRole('button', { name: '重试这份文件' }).click()
  await page.waitForFunction(() => window.recognitionCalls.length === 2)
  await page.evaluate(() => window.finishRecognition({ fields: {
    companyName: '读到的合成测试有限公司', establishedOn: '2018-02-26', taxId: '111111111111111111',
  } }))
  await left.locator('[data-qianlai-document-file="ready"]').getByText('合成营业执照.png').waitFor()
  assert.equal(await left.getByRole('textbox', { name: '企业全称' }).inputValue(), '手填的合成测试有限公司')
  assert.equal(await left.locator('input[name="establishedOn"]').inputValue(), '2018-02-26')
  assert.equal(await right.getByRole('textbox', { name: '企业全称' }).inputValue(), '')
  await left.getByRole('button', { name: '确认公司资料' }).click()
  await page.waitForFunction(() => document.querySelector('#right input[name="companyName"]').value === '手填的合成测试有限公司')
  assert.deepEqual(await page.evaluate(() => window.recognitionCalls), ['合成营业执照.png', '合成营业执照.png'])
  assert.deepEqual(errors, [])
  console.log('PASS: native file picker, busy animation, reduced motion, retry, and explicit confirmation before writeback')
} catch (error) {
  await screenshot('failed-step')
  if (errors.length) console.error('Client errors', errors)
  throw error
} finally {
  await browser.close()
}
