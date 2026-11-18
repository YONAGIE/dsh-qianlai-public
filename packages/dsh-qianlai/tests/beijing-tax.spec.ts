import type { Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'

import { parseTaxProfile, readTaxProfile, waitForTaxPortalLogin, type TaxPageData } from '../src/tax-portal.js'
import { taxPortalFor } from '../src/tax-portals.js'

const beijing = taxPortalFor('北京市', '北京市')!
const now = new Date('2026-11-15T08:00:00.000Z')
const company = { companyName: '合成北京服务企业', taxId: '91110000MA00000000' }
const source = 'https://etax.beijing.chinatax.gov.cn:8443/query'
const basic: TaxPageData = {
  url: source,
  headings: ['纳税人信息查询'],
  facts: [
    ['纳税人名称', company.companyName],
    ['纳税人识别号', company.taxId],
    ['主管税务机关', '国家税务总局北京市某区税务局'],
    ['增值税纳税人资格', '小规模纳税人'],
  ],
  tables: [],
}
const recognition: TaxPageData = {
  url: source + '?fixture=1#tax',
  headings: ['税费种认定信息'],
  facts: [],
  tables: [[
    ['征收项目', '纳税期限', '认定有效期起', '认定有效期止'],
    ['增值税', '季', '2026-11-01', '9999-12-31'],
  ]],
}

describe('北京电子税务局', () => {
  it('通过北京主管机关核对，返回可回填的税务字段和公开来源', () => {
    expect(parseTaxProfile(beijing, basic, recognition, company, now)).toEqual({
      ...company, authority: '国家税务总局北京市某区税务局', taxpayerQualification: '小规模纳税人',
      observedAt: now.toISOString(), sourceUrl: source, obligationCoverage: 'visible_page',
      obligations: [{ taxItem: '增值税', filingCycle: '季', effectiveFrom: '2026-11-01', effectiveTo: '9999-12-31' }],
    })
  })

  it('用所选企业的官方信息建立待核对结果，成立日期必须来自对应字段', () => {
    const blank = { companyName: '', taxId: '' }
    const registered = { ...basic, facts: [...basic.facts, ['税务登记日期', '2025-02-10']] }
    expect(parseTaxProfile(beijing, registered, recognition, blank, now)).toMatchObject({
      ...company, registrationDate: '2025-02-10',
    })
    expect(parseTaxProfile(beijing, registered, recognition, blank, now)).not.toHaveProperty('establishedOn')
    expect(parseTaxProfile(beijing, {
      ...registered, facts: [...registered.facts, ['成立日期', '2025 年 2 月 3 日']],
    }, recognition, blank, now)).toMatchObject({ establishedOn: '2025-02-03' })
    expect(parseTaxProfile(beijing, {
      ...registered, facts: [...registered.facts, ['成立日期', '2025-02-31']],
    }, recognition, blank, now)).not.toHaveProperty('establishedOn')
    expect(() => parseTaxProfile(beijing, registered, recognition, { ...blank, companyName: '另一企业' }, now))
      .toThrow(expect.objectContaining({ code: 'TAX_IDENTITY_MISMATCH' }))
  })

  it('二维码、公共首页和非官方页面不触发读取，出现企业查询后自动继续', async () => {
    let selected = false
    const browserContext = { pages: () => [login, home, thirdParty] }
    function page(url: () => string, display: () => string[]) {
      const inspect = vi.fn(async () => undefined)
      const frame = {
        evaluate: inspect, url,
        getByText: (text: RegExp) => ({ filter: () => ({ count: async () => display().filter(value => text.test(value)).length }) }),
      }
      const item = { url, frames: () => [frame], isClosed: () => false, context: () => browserContext }
      return { page: item as unknown as Page, inspect }
    }
    const { page: login, inspect: inspectLogin } = page(
      () => selected ? beijing.homeOrigin + '/enterprise' : beijing.loginOrigin + '/login',
      () => selected ? ['退出登录', '我要查询'] : ['企业业务', '请选择企业'],
    )
    const { page: home, inspect: inspectHome } = page(() => beijing.homeOrigin, () => ['切换身份', '我要查询', '登录'])
    const { page: thirdParty, inspect: inspectThirdParty } = page(() => 'https://example.test/', () => ['退出登录', '我要查询'])
    const stop = new AbortController()
    const result = waitForTaxPortalLogin(beijing, login, stop.signal)
    try {
      await vi.waitFor(() => expect(inspectHome).toHaveBeenCalledTimes(1))
      expect(inspectLogin).not.toHaveBeenCalled()
      expect(inspectThirdParty).not.toHaveBeenCalled()
      selected = true
      await expect(result).resolves.toBe(login)
    } finally {
      stop.abort()
      await result.catch(() => {})
    }
  })

  it('菜单依次加载或查询另开标签页时仍只打开已知的只读查询', async () => {
    const selections: string[] = []
    const route = ['我要查询', '一户式查询', '纳税人信息查询']
    const browserContext = { pages: () => selections.length === route.length ? [home, query] : [home] }
    function page(url: string, snapshot?: TaxPageData) {
      const frame = {
        evaluate: async () => snapshot, url: () => url,
        getByText: (label: string) => ({ filter: () => ({
          count: async () => Number(label === route[selections.length]),
          click: async () => { selections.push(label) },
        }) }),
      }
      return { url: () => url, frames: () => [frame], isClosed: () => false, context: () => browserContext } as unknown as Page
    }
    const home = page(beijing.homeOrigin + '/enterprise')
    const query = page(source, { ...basic, tables: recognition.tables })
    await expect(readTaxProfile(beijing, home, { companyName: '', taxId: '' }, new AbortController().signal))
      .resolves.toMatchObject({ ...company, sourceUrl: source })
    expect(selections).toEqual(route)
  })

  it('接受北京经开区税务机关的名称', () => {
    const authority = '国家税务总局北京经济技术开发区税务局'
    const facts = basic.facts.map(([key, value]) => [key!, key === '主管税务机关' ? authority : value!])
    expect(parseTaxProfile(beijing, { ...basic, facts }, recognition, company, now)).toMatchObject({ authority })
  })

  it('拒绝北京查询中出现的其他辖区主管机关', () => {
    const facts = basic.facts.map(([key, value]) =>
      [key!, key === '主管税务机关' ? '国家税务总局杭州市某区税务局' : value!])
    expect(() => parseTaxProfile(beijing, { ...basic, facts }, recognition, company, now))
      .toThrow(expect.objectContaining({ code: 'TAX_AUTHORITY_UNVERIFIED' }))
  })

  it.each([
    'https://etax.zhejiang.chinatax.gov.cn:8443/query',
    'https://tpass.beijing.chinatax.gov.cn:8443/query',
    'https://etax.beijing.chinatax.gov.cn.example.test:8443/query',
  ])('拒绝把 %s 作为北京税务资料来源', url => {
    expect(() => parseTaxProfile(beijing, basic, { ...recognition, url }, company, now))
      .toThrow(expect.objectContaining({ code: 'TAX_QUERY_UNRECOGNIZED' }))
  })
})
