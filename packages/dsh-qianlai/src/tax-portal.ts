import { setTimeout as pause } from 'node:timers/promises'

import type { BrowserContext, Frame, Page } from 'playwright-core'

import { isCalendarDate } from './period.js'
import type { TaxPortal } from './tax-portals.js'

const QUERY_TITLES = ['纳税人信息查询', '纳税人信息']
const QUERY_PATH = ['纳税人信息查询', '一户式查询', '我要查询']
const TAX_TABS = ['税费种认定信息', '税（费）种认定信息', '税(费)种认定信息']
const LABELS = {
  companyName: ['纳税人名称', '企业名称'],
  taxId: ['统一社会信用代码', '纳税人识别号', '统一社会信用代码/纳税人识别号'],
  authority: ['主管税务机关', '主管税务机关名称'],
  establishedOn: ['成立日期', '企业成立日期', '成立时间'],
  registrationStatus: ['税务登记状态', '登记状态'],
  registrationDate: ['税务登记日期', '登记日期'],
  taxpayerStatus: ['纳税人状态'],
  taxpayerQualification: ['增值税纳税人资格', '增值税纳税人类型', '纳税人资格', '纳税人身份'],
  incomeMethod: ['企业所得税征收方式'],
  accountingSystem: ['会计制度', '适用会计制度'],
} as const
const TAX_COLUMNS = {
  taxItem: ['征收项目', '税种', '税种名称', '税费种', '税费种名称'],
  taxCategory: ['征收品目', '品目'],
  filingCycle: ['纳税期限', '申报周期', '申报期限'],
  effectiveFrom: ['认定有效期起', '税费种认定有效期起', '有效期起', '有效期起始日期', '认定有效期起始日期'],
  effectiveTo: ['认定有效期止', '税费种认定有效期止', '有效期止', '有效期终止日期', '认定有效期终止日期'],
} as const

export interface TaxSubject {
  companyName: string
  taxId: string
}

type Obligation = {
  taxItem: string
  taxCategory?: string
  filingCycle?: string
  effectiveFrom?: string
  effectiveTo?: string
}

export interface TaxProfile extends TaxSubject {
  authority: string
  establishedOn?: string
  registrationStatus?: string
  registrationDate?: string
  taxpayerStatus?: string
  taxpayerQualification?: string
  incomeMethod?: string
  accountingSystem?: string
  obligations: Obligation[]
  obligationCoverage: 'visible_page'
  observedAt: string
  sourceUrl: string
}

export class TaxPortalError extends Error {
  constructor(
    readonly code: 'TAX_LOGIN_UNAVAILABLE' | 'TAX_LOGIN_PENDING' | 'TAX_QUERY_UNRECOGNIZED' | 'TAX_IDENTITY_MISMATCH' | 'TAX_AUTHORITY_UNVERIFIED',
    message: string,
  ) { super(message) }
}

function officialUrl(site: TaxPortal, text: string, includeLogin: boolean) {
  const url = URL.parse(text)
  if (!url || url.username || url.password ||
      !(site.portalOrigins.includes(url.origin) || (includeLogin && url.origin === site.loginOrigin))) return undefined
  return url
}

async function waitFor<T>(read: () => Promise<T | undefined>, signal: AbortSignal, timeout: number, interval = 180) {
  const end = Date.now() + timeout
  do {
    signal.throwIfAborted()
    const value = await read()
    if (value !== undefined) return value
    await pause(interval, undefined, { signal })
  } while (Date.now() < end)
  signal.throwIfAborted()
}

export async function openTaxPortalLogin(site: TaxPortal, context: BrowserContext, signal: AbortSignal): Promise<Page> {
  signal.throwIfAborted()
  // Context-level routing also covers the first request of a login popup.
  await context.route('**/*', async route => {
    const request = route.request()
    if (request.isNavigationRequest() && !officialUrl(site, request.url(), true)) return route.abort('blockedbyclient')
    await route.fallback()
  })
  context.on('page', page => {
    // A navigation that completes outside the verified origins (such as a server redirect)
    // must never be used for credentials or data. Blank popup documents are transitional.
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && frame.url() !== 'about:blank' && !officialUrl(site, frame.url(), true))
        void page.close().catch(() => {})
    })
  })
  try {
    const page = await context.newPage()
    await page.goto(site.homeOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 15_000 })
    signal.throwIfAborted()
    if (officialUrl(site, page.url(), true)?.origin !== site.loginOrigin) {
      if (!officialUrl(site, page.url(), false)) throw Error('origin')
      await page.locator('span.loginBtn').filter({ visible: true }).click({ timeout: 6000 })
    }
    const ready = await waitFor(async () => {
      for (const candidate of context.pages()) {
        if (officialUrl(site, candidate.url(), true)?.origin !== site.loginOrigin) continue
        const ready = await candidate.evaluate(() => {
          const qr = document.querySelector<HTMLImageElement>('img[alt="Scan me!"]')
          return !!(qr?.complete && qr.naturalWidth > 0 && qr.getClientRects().length &&
            document.querySelector('span.activeCls')?.textContent?.trim() === '企业业务' &&
            /电子税务局APP扫一扫/.test(document.body.innerText))
        }).catch(() => false)
        if (ready && officialUrl(site, candidate.url(), true)?.origin === site.loginOrigin) return candidate
      }
    }, signal, 12_000)
    if (ready) return ready
  } catch {
    signal.throwIfAborted()
  }
  throw new TaxPortalError('TAX_LOGIN_UNAVAILABLE', `未打开${site.name}电子税务局的企业扫码页，请重试或上传官方资料。`)
}

export interface TaxPageData {
  url: string
  headings: string[]
  facts: string[][]
  tables: string[][][]
  emptyRecognitions?: boolean
}

const normal = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').replace(/[：:]$/, '')
const identityId = (value: string) => normal(value).toUpperCase()
const visibleValue = (value?: string) => value?.trim() && !/^(?:[-—]+|暂无|请选择|未显示)$/.test(value.trim()) ? value.trim() : undefined

function unrecognized() {
  return new TaxPortalError('TAX_QUERY_UNRECOGNIZED', '请在对应的电子税务局打开「纳税人信息查询」，核对基本信息和税费种认定信息后重试。也可上传官方导出或截图。')
}

function readFact(data: TaxPageData, candidates: readonly string[]) {
  const keys = new Set(candidates.map(normal))
  const values = data.facts.flatMap(([label, value]) => label && keys.has(normal(label)) && visibleValue(value) ? [value!.trim()] : [])
  const identities = new Set(values.map(normal))
  if (identities.size > 1) throw unrecognized()
  return values[0]
}

function requireSubject(site: TaxPortal, data: TaxPageData, expected: TaxSubject) {
  if (!officialUrl(site, data.url, false) || !data.headings.some(label => QUERY_TITLES.some(title => normal(title) === normal(label)))) throw unrecognized()
  const companyName = readFact(data, LABELS.companyName)
  const taxId = readFact(data, LABELS.taxId)
  if (!companyName || !taxId || !/^[0-9A-Z]{18}$/.test(identityId(taxId))) throw unrecognized()
  if ((expected.companyName && normal(companyName) !== normal(expected.companyName)) ||
      (expected.taxId && identityId(taxId) !== identityId(expected.taxId)))
    throw new TaxPortalError('TAX_IDENTITY_MISMATCH', '税务局当前企业与建档企业不一致。请切换到对应企业后重试。')
  const authority = readFact(data, LABELS.authority)
  if (!authority || !site.acceptsAuthority(authority) || !/(?:税务局|税务分局|税务所|税务机关)/.test(authority))
    throw new TaxPortalError('TAX_AUTHORITY_UNVERIFIED', `无法核对${site.name}主管税务机关，请核对当前企业的税务地区或上传官方资料。`)
  return { companyName, taxId: identityId(taxId), authority }
}

function recognizedTable(data: TaxPageData) {
  const matches = data.tables.filter(table => table.length > 1 &&
    table[0]?.some(cell => TAX_COLUMNS.taxItem.some(label => normal(cell) === normal(label))))
  if (new Set(matches.map(table => JSON.stringify(table))).size > 1) throw unrecognized()
  return matches[0]
}

export function parseTaxProfile(
  site: TaxPortal, basic: TaxPageData, tax: TaxPageData, expected: TaxSubject, now: Date,
): TaxProfile {
  const subject = requireSubject(site, basic, expected)
  const url = officialUrl(site, tax.url, false)
  if (!url || url.origin !== officialUrl(site, basic.url, false)?.origin ||
    !tax.headings.some(label => [...QUERY_TITLES, ...TAX_TABS].some(title => normal(title) === normal(label))))
    throw unrecognized()

  const name = readFact(tax, LABELS.companyName)
  const taxId = readFact(tax, LABELS.taxId)
  if ((name && normal(name) !== normal(subject.companyName)) || (taxId && identityId(taxId) !== subject.taxId))
    throw new TaxPortalError('TAX_IDENTITY_MISMATCH', '查询期间税务局的企业主体发生变化，请核对后重试。')
  const authority = readFact(tax, LABELS.authority)
  if (authority && normal(authority) !== normal(subject.authority))
    throw new TaxPortalError('TAX_AUTHORITY_UNVERIFIED', '查询期间主管税务机关发生变化，请核对后重试。')

  const table = recognizedTable(tax)
  if (!table && !tax.emptyRecognitions) throw unrecognized()
  const [headers = [], ...rows] = table ?? []
  const column = (name: keyof typeof TAX_COLUMNS) =>
    headers.findIndex(header => TAX_COLUMNS[name].some(label => normal(label) === normal(header)))
  const indexes = Object.fromEntries(Object.keys(TAX_COLUMNS).map(name => [name, column(name as keyof typeof TAX_COLUMNS)]))
  const obligations = rows.flatMap(row => {
    const taxItem = visibleValue(row[indexes.taxItem!])
    if (!taxItem || /^(暂无数据|没有数据|无数据)$/.test(taxItem)) return []
    const result: Obligation = { taxItem }
    for (const name of ['taxCategory', 'filingCycle', 'effectiveFrom', 'effectiveTo'] as const) {
      const value = visibleValue(row[indexes[name]!])
      if (value) result[name] = value
    }
    return [result]
  })
  if (!obligations.length && !tax.emptyRecognitions) throw unrecognized()
  const profile: TaxProfile = {
    ...subject, obligations, obligationCoverage: 'visible_page',
    observedAt: now.toISOString(), sourceUrl: url.origin + url.pathname,
  }
  const establishment = readFact(basic, LABELS.establishedOn)
  if (establishment) {
    const date = establishment.normalize('NFKC').replace(/\s/g, '').match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
    if (date) {
      const establishedOn = `${date[1]}-${date[2]!.padStart(2, '0')}-${date[3]!.padStart(2, '0')}`
      if (isCalendarDate(establishedOn)) profile.establishedOn = establishedOn
    }
  }
  for (const name of ['registrationStatus', 'registrationDate', 'taxpayerStatus', 'taxpayerQualification', 'incomeMethod', 'accountingSystem'] as const) {
    const value = readFact(basic, LABELS[name])
    if (value) profile[name] = value
  }
  return profile
}

async function capture(site: TaxPortal, frame: Frame): Promise<TaxPageData | undefined> {
  if (!officialUrl(site, frame.url(), false)) return undefined
  const snapshot = await frame.evaluate(({ titles, taxTabs, labels, taxHeaders }) => {
    const isVisible = (element: HTMLElement) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'
    const clean = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').replace(/[:：]$/, '')
    const text = (element?: Element | null) => element instanceof HTMLElement && isVisible(element) ? element.innerText.trim() : ''
    const wanted = new Set(labels.map(clean))
    const knownHeadings = new Set([...titles, ...taxTabs].map(clean))
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,a,[role="tab"]'))
      .map(text).filter(value => value.length <= 28 && knownHeadings.has(clean(value)))
    if (!headings.length) return
    const facts: string[][] = []
    const add = (label: string, value: string) => {
      if (wanted.has(clean(label)) && value && value.length <= 180) facts.push([label, value])
    }
    for (const element of Array.from(document.querySelectorAll('dt,th,td,label,.el-descriptions__label,.ant-descriptions-item-label,span'))) {
      const label = text(element)
      if (!label || !wanted.has(clean(label))) continue
      const sibling = text(element.nextElementSibling)
      const container = element.closest('.el-form-item,.ant-form-item,.van-field,.el-descriptions__cell')
      const mapped = container?.querySelector('.el-form-item__content,.ant-form-item-control,.van-field__value,.el-descriptions__content')
      add(label, sibling || text(mapped))
    }
    const readRows = (rows: HTMLCollectionOf<HTMLTableRowElement>) =>
      Array.from(rows).filter(isVisible).slice(0, 501).map(row => Array.from(row.cells).map(cell => text(cell).slice(0, 180)))
    const matrices = Array.from(document.querySelectorAll('table')).filter(isVisible).map(table => readRows(table.rows))
    for (const wrapper of Array.from(document.querySelectorAll('.el-table, .ant-table-container'))) {
      const header = wrapper.querySelector<HTMLTableSectionElement>('.el-table__header-wrapper thead, .ant-table-header thead')
      const body = wrapper.querySelector<HTMLTableSectionElement>('.el-table__body-wrapper tbody, .ant-table-body tbody')
      if (header && body) matrices.push([...readRows(header.rows), ...readRows(body.rows)])
    }
    const tables = matrices.flatMap(matrix => {
      const header = matrix.findIndex(row => row.some(value => taxHeaders.some(label => clean(label) === clean(value))))
      return header >= 0 ? [matrix.slice(header)] : []
    })
    // An empty state only counts within the tax recognition table.
    const emptyRecognitions = tables.some(table => table.slice(1).some(row => row.some(cell => /^(暂无数据|没有数据|无数据)$/.test(cell))))
    return { url: location.origin + location.pathname, headings, facts, tables, emptyRecognitions }
  }, {
    titles: QUERY_TITLES, taxTabs: TAX_TABS, labels: Object.values(LABELS).flat(), taxHeaders: TAX_COLUMNS.taxItem,
  }).catch(() => undefined)
  return snapshot && officialUrl(site, snapshot.url, false) ? snapshot : undefined
}

async function querySurface(site: TaxPortal, page: Page, signal: AbortSignal) {
  for (const frame of page.frames()) {
    signal.throwIfAborted()
    const data = await capture(site, frame)
    if (!data?.headings.some(title => QUERY_TITLES.some(known => normal(known) === normal(title)))) continue
    const labels = data.facts.map(([label]) => label && normal(label))
    if (LABELS.companyName.some(label => labels.includes(normal(label))) && LABELS.taxId.some(label => labels.includes(normal(label))))
      return { frame, data }
  }
}

/** Wait for the user to finish their own sign-in and choose an enterprise. */
export async function waitForTaxPortalLogin(site: TaxPortal, login: Page, signal: AbortSignal): Promise<Page> {
  const context = login.context()
  const ready = await waitFor(async () => {
    for (const candidate of context.pages()) {
      signal.throwIfAborted()
      if (candidate.isClosed() || !officialUrl(site, candidate.url(), false)) continue
      if (await querySurface(site, candidate, signal) && officialUrl(site, candidate.url(), false)) return candidate
      for (const frame of candidate.frames()) {
        signal.throwIfAborted()
        if (!officialUrl(site, frame.url(), false)) continue
        const signedIn = await frame.getByText(/^(?:身份切换|切换身份|退出登录|安全退出|退出)$/)
          .filter({ visible: true }).count().catch(() => 0)
        if (!signedIn) continue
        const signedOut = await frame.getByText(/^登\s*录$/).filter({ visible: true }).count().catch(() => 0)
        const query = await frame.getByText(/^(?:我要查询|一户式查询|纳税人信息查询)$/)
          .filter({ visible: true }).count().catch(() => 0)
        if (!signedOut && query && officialUrl(site, candidate.url(), false)) return candidate
      }
    }
  }, signal, 15 * 60_000, 850)
  if (!ready) throw new TaxPortalError('TAX_LOGIN_PENDING', '未能确认已进入企业业务，请重新扫码并选择企业。')
  return ready
}

async function clickQueryLabel(site: TaxPortal, page: Page, label: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!officialUrl(site, page.url(), false)) return false
  for (const frame of page.frames()) {
    if (!officialUrl(site, frame.url(), false)) continue
    const locator = frame.getByText(label, { exact: true }).filter({ visible: true })
    if (await locator.count().catch(() => 0) !== 1 || !officialUrl(site, frame.url(), false)) continue
    signal.throwIfAborted()
    if (await locator.click({ timeout: 1500 }).then(() => true, () => false)) return true
  }
  return false
}

export async function readTaxProfile(site: TaxPortal, page: Page, expected: TaxSubject, signal: AbortSignal): Promise<TaxProfile> {
  signal.throwIfAborted()
  const context = page.context()
  const officialPages = () => [...new Set([page, ...context.pages().reverse()])]
    .filter(candidate => !candidate.isClosed() && officialUrl(site, candidate.url(), false))
  const clicked = new Set<string>()
  const query = await waitFor(async () => {
    const candidates = officialPages()
    if (!candidates.length) throw new TaxPortalError('TAX_LOGIN_PENDING', '请先在浏览器里扫码并完成企业身份确认。')
    for (const candidate of candidates) {
      const surface = await querySurface(site, candidate, signal)
      if (surface && officialUrl(site, candidate.url(), false)) return { portal: candidate, ...surface }
    }
    for (const label of QUERY_PATH) {
      if (clicked.has(label)) continue
      const [portal] = candidates
      if (portal && await clickQueryLabel(site, portal, label, signal)) {
        clicked.add(label)
        break
      }
    }
  }, signal, 8000, 250)
  if (!query) throw unrecognized()
  const { portal, data: basic, frame } = query
  requireSubject(site, basic, expected)
  if (recognizedTable(basic) || basic.emptyRecognitions) return parseTaxProfile(site, basic, basic, expected, new Date())
  for (const label of TAX_TABS) {
    if (!officialUrl(site, frame.url(), false)) throw unrecognized()
    signal.throwIfAborted()
    const tab = frame.getByText(label, { exact: true }).filter({ visible: true })
    if (await tab.count() !== 1) continue
    await tab.click({ timeout: 1800 }).catch(() => {})
    break
  }
  const tax = await waitFor(async () => {
    const observed = await capture(site, frame)
    if (observed && (recognizedTable(observed) || observed.emptyRecognitions)) return observed
  }, signal, 4000)
  if (!tax || !officialUrl(site, portal.url(), false)) throw unrecognized()
  return parseTaxProfile(site, basic, tax, expected, new Date())
}
