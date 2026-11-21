import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const wait = ms => new Promise(done => setTimeout(done, ms))

// The official first-run UI keeps #root inert while either dialog is open.
// Acknowledge only these known, localized steps through the visible controls.
async function dismissFirstRunDialog(page, acknowledged) {
  const notices = [
    { title: /^(预览版说明|Preview Notice)$/, button: /^(继续|Continue)$/, label: 'preview notice' },
    { title: /^(添加一个 API Key 开始使用|Add an API key to get started)$/, button: /^(稍后配置|Configure later)$/, label: 'model setup' },
  ]
  for (const { title, button, label } of notices) {
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title }) })
    if (!await dialog.isVisible()) continue
    await dialog.getByRole('button', { name: button }).click({ timeout: 4_000 })
    await dialog.waitFor({ state: 'hidden', timeout: 6_000 })
    acknowledged.push(label)
    return true
  }
  return false
}

async function dialogSnapshot(page) {
  return page.locator('dialog[open]:visible,[role="dialog"]:visible,[role="alertdialog"]:visible').evaluateAll(nodes =>
    nodes.slice(0, 5).map(node => ({
      heading: (node.querySelector('h1,h2,h3,[role="heading"]')?.textContent ?? node.getAttribute('aria-label') ?? '').trim().slice(0, 100),
      text: node.innerText.trim().replace(/\s+/g, ' ').slice(0, 230),
      buttons: [...node.querySelectorAll('button,[role="button"]')].filter(button => button.getClientRects().length)
        .slice(0, 8).map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim().slice(0, 55)),
    })))
}

async function revealSession(page, sessionId, acknowledged) {
  const row = page.locator(`[data-row-key="session:${sessionId}"]:visible`)
  const rootInert = page.locator('#root[inert]')
  const deadline = Date.now() + 27_000
  while (Date.now() < deadline) {
    if (await dismissFirstRunDialog(page, acknowledged)) continue
    if (await rootInert.count()) {
      await wait(180)
      continue
    }
    if (await row.count()) {
      try {
        if (await row.getAttribute('aria-selected') !== 'true')
          await row.click({ timeout: 4_000 })
        return
      } catch (error) {
        if (!await rootInert.count()) throw error
        continue
      }
    }
    const sidebar = page.getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ }).first()
    if (await sidebar.isVisible()) await sidebar.click({ timeout: 3_000 })
    else {
      const group = page.locator('[data-row-key^="workspace:"][aria-expanded="false"]:visible').first()
      const more = page.locator('[data-row-key^="overflow:"][aria-expanded="false"]:visible').first()
      if (await group.isVisible()) await group.click({ timeout: 3_000 })
      else if (await more.isVisible()) await more.click({ timeout: 3_000 })
    }
    await wait(180)
  }
  throw Error(await rootInert.count() ? 'DSH 首启弹层仍阻止会话操作' : '已有回复的合成会话未出现在 DSH 工作区列表')
}

function isOnboardingResponse(response, sessionId, action) {
  if (new URL(response.url()).pathname !== '/api/qianlai/company-onboarding') return false
  try {
    const payload = response.request().postDataJSON()?.payload
    return payload?.sessionId === sessionId && payload?.action === action
  } catch {
    return false
  }
}

function cookiesFromHeader(cookie, origin) {
  return cookie.split(/;\s*/).filter(Boolean).map(pair => {
    const split = pair.indexOf('=')
    assert.ok(split > 0, '隔离宿主的 Cookie 格式不正确')
    return { name: pair.slice(0, split), value: pair.slice(split + 1), url: origin }
  })
}

/**
 * The supplied session must already have a completed ordinary reply, and its isolated
 * DSH_HOME must still have no onboarding draft. Uses the real browser and real DSH
 * HTTP APIs. Returns the actual open-entry result so the caller can use its mode card.
 */
export async function checkOnboardingBrowser({
  loginUrl, sessionId, replyText, cookie = '', evidenceDir, repoDir = process.cwd(),
  chromiumPath = process.env.PHASE_CHROMIUM,
}) {
  const login = new URL(loginUrl)
  assert.ok(login.protocol === 'http:' && login.hostname === '127.0.0.1' && login.port && !login.username && !login.password,
    '浏览器验收需要连接隔离的回环 DSH 宿主')
  assert.match(sessionId, /^[A-Za-z0-9_.:-]+$/)
  const playwright = createRequire(resolve(repoDir, 'packages/dsh-qianlai/package.json'))('playwright-core')
  const browser = await playwright.chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) })
  let page
  let stage = '打开隔离 DSH'
  const errors = []
  const acknowledged = []
  const token = login.searchParams.get('token')
  const scrub = text => {
    const redacted = String(text).replace(/([?&]token=)[^&\s"'<>]+/g, '$1[redacted]')
      .replace(/\b(?:sk-[\w.-]{5,}|Bearer\s+[\w.-]{6,})/gi, '[redacted]')
    const noToken = token ? redacted.replaceAll(token, '[redacted]') : redacted
    return cookiesFromHeader(cookie, login.origin).reduce((value, { value: cookieValue }) =>
      cookieValue.length > 5 ? value.replaceAll(cookieValue, '[redacted]') : value, noToken)
  }
  const screenshot = async name => {
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await page.screenshot({ path: resolve(evidenceDir, name + '.png'), timeout: 6_000 })
    }
  }
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', error => errors.push(scrub(error.message)))
    if (cookie) await context.addCookies(cookiesFromHeader(cookie, login.origin))
    const response = await page.goto(cookie ? login.origin + login.pathname : login.href,
      { waitUntil: 'domcontentloaded', timeout: 25_000 })
    assert.ok(response?.ok(), 'DSH 页面未成功响应')

    stage = '打开已收到合成回复的钱来张姐会话'
    await revealSession(page, sessionId, acknowledged)
    const reply = replyText ? page.getByText(replyText, { exact: true }).and(page.getByRole('paragraph')) : undefined
    if (reply) await reply.waitFor({ state: 'visible' })

    stage = '确认正文后的开始建档入口'
    const begin = page.getByRole('button', { name: '开始建档', exact: true })
    await begin.waitFor({ state: 'visible' })
    assert.equal(await begin.count(), 1, '同一回复只应显示一个入口')
    if (reply) {
      const replyElement = await reply.elementHandle()
      try {
        const afterReply = await begin.evaluate((button, text) =>
          Boolean(text.compareDocumentPosition(button) & 4), replyElement)
        assert.ok(afterReply, '建档入口应在回复正文之后')
      } finally {
        await replyElement.dispose()
      }
    }
    await screenshot('dsh-before-onboarding')

    stage = '点击入口并核验宿主回执'
    const [openedResponse] = await Promise.all([
      page.waitForResponse(response => isOnboardingResponse(response, sessionId, 'open-entry')),
      begin.click(),
    ])
    assert.ok(openedResponse.ok(), '建档动作没有得到正常的 HTTP 回执')
    const result = (await openedResponse.json()).result
    assert.equal(result?.ok, true)
    assert.equal(result.value?.accepted, true)
    assert.equal(result.value?.entry, 'start')
    assert.equal(result.value?.card?.kind, 'mode')

    stage = '确认左侧方式卡和右侧企业建档'
    const card = page.locator('[data-qianlai-onboarding-card][aria-label="选择建档方式"]')
    const panel = page.locator('[data-qianlai-onboarding]')
    await Promise.all([
      card.waitFor({ state: 'visible' }),
      panel.waitFor({ state: 'visible' }),
      card.getByRole('button', { name: '手动填写', exact: true }).waitFor({ state: 'visible' }),
      panel.getByRole('heading', { name: '建档资料', exact: true }).waitFor({ state: 'visible' }),
    ])
    const [left, right] = await Promise.all([card.boundingBox(), panel.boundingBox()])
    assert.ok(left && right && left.x < right.x, '方式卡和企业建档没有分别出现在左、右区域')
    await screenshot('dsh-onboarding-entry')
    return { opened: result.value, pageErrors: errors, acknowledged }
  } catch (error) {
    const dialogs = page ? await dialogSnapshot(page).catch(() => []) : []
    if (page) await screenshot('dsh-onboarding-failure').catch(() => {})
    const diagnostics = [
      dialogs.length ? '可见弹层 ' + scrub(JSON.stringify(dialogs)).slice(0, 1200) : '',
      errors.length ? '页面异常 ' + errors.slice(0, 3).join(' / ') : '',
    ].filter(Boolean).join(' | ')
    throw Error(stage + '：' + scrub(error.message).slice(0, 1500) + (diagnostics ? ' | ' + diagnostics : ''))
  } finally {
    await browser.close()
  }
}
