import { describe, expect, it } from 'vitest'

import { parseTaxProfile, type TaxPageData } from '../src/tax-portal.js'
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
