import { describe, expect, it } from 'vitest'

import { parseZhejiangTaxProfile, TaxPortalError, type TaxPageData } from '../src/zhejiang-tax.js'

const now = new Date('2026-11-15T08:00:00.000Z')
const expected = { companyName: '合成税务样本有限公司', taxId: '91330000MA00000000' }

const basic: TaxPageData = {
  url: 'https://etax.zhejiang.chinatax.gov.cn:8443/query?flow=fixture-only',
  headings: ['纳税人信息查询'],
  facts: [
    ['纳税人名称：', expected.companyName],
    ['统一社会信用代码：', expected.taxId],
    ['主管税务机关', '国家税务总局杭州市某区税务局'],
    ['税务登记状态', '已登记'],
    ['增值税纳税人资格', '小规模纳税人'],
  ],
  tables: [],
}

const recognition: TaxPageData = {
  url: 'https://etax.zhejiang.chinatax.gov.cn:8443/query?flow=fixture-only#tax',
  headings: ['税（费）种认定信息'],
  facts: [],
  tables: [[
    ['征收项目', '征收品目', '纳税期限', '认定有效期起', '认定有效期止'],
    ['增值税', '小规模纳税人', '季', '2026-11-01', '9999-12-31'],
  ]],
}

function expectPortalError(action: () => unknown, code: TaxPortalError['code']) {
  try {
    action()
    throw Error('预期读取停止')
  } catch (error) {
    expect(error).toBeInstanceOf(TaxPortalError)
    expect(error).toMatchObject({ code })
  }
}

describe('浙江电子税务局企业信息识别', () => {
  it('只读取目标字段，保留来源和当前页覆盖范围', () => {
    expect(parseZhejiangTaxProfile(
      { ...basic, facts: [...basic.facts, ['联系电话', '合成联系方式']] },
      recognition, expected, now,
    )).toEqual({
      ...expected,
      authority: '国家税务总局杭州市某区税务局',
      registrationStatus: '已登记',
      taxpayerQualification: '小规模纳税人',
      sourceUrl: 'https://etax.zhejiang.chinatax.gov.cn:8443/query',
      observedAt: now.toISOString(),
      obligationCoverage: 'visible_page',
      obligations: [{ taxItem: '增值税', taxCategory: '小规模纳税人', filingCycle: '季', effectiveFrom: '2026-11-01', effectiveTo: '9999-12-31' }],
    })
  })

  it('同名但代码不一致，以及读取途中企业变化时拒绝', () => {
    expectPortalError(() => parseZhejiangTaxProfile(basic, recognition, {
      ...expected, taxId: '91330000MA00000001',
    }, now), 'TAX_IDENTITY_MISMATCH')
    expectPortalError(() => parseZhejiangTaxProfile(basic, {
      ...recognition, facts: [['纳税人名称', '另一合成企业']],
    }, expected, now), 'TAX_IDENTITY_MISMATCH')
  })

  it('企业字段有冲突时不选择任一候选', () => {
    expectPortalError(() => parseZhejiangTaxProfile({
      ...basic, facts: [...basic.facts, ['企业名称', '另一合成企业']],
    }, recognition, expected, now), 'TAX_QUERY_UNRECOGNIZED')
  })

  it('登记主体可匹配也必须核对主管税务机关，宁波走独立地区入口', () => {
    const facts = basic.facts.map(([label, value]) => [label!, label === '主管税务机关' ? '国家税务总局宁波市税务局' : value!])
    expectPortalError(() => parseZhejiangTaxProfile({ ...basic, facts }, recognition, expected, now), 'TAX_AUTHORITY_UNVERIFIED')
  })

  it.each([
    'https://etax.zhejiang.chinatax.gov.cn.example.test:8443/query',
    'https://etax.zhejiang.chinatax.gov.cn:9443/query',
    'http://etax.zhejiang.chinatax.gov.cn:8443/query',
    'https://tpass.zhejiang.chinatax.gov.cn:8443/query',
  ])('拒绝未验证来源 %s', url => {
    expectPortalError(() => parseZhejiangTaxProfile(basic, { ...recognition, url }, expected, now), 'TAX_QUERY_UNRECOGNIZED')
  })

  it('有多个不同的税费种表时要求打开目标查询页', () => {
    const conflicting = [recognition.tables[0]![0]!, ['企业所得税', '其他', '月']]
    expectPortalError(() => parseZhejiangTaxProfile(basic, {
      ...recognition, tables: [...recognition.tables, conflicting],
    }, expected, now), 'TAX_QUERY_UNRECOGNIZED')
  })

  it('空表必须来自官方当前页的明确空状态', () => {
    const noRows = { ...recognition, tables: [recognition.tables[0]!.slice(0, 1)] }
    expectPortalError(() => parseZhejiangTaxProfile(basic, noRows, expected, now), 'TAX_QUERY_UNRECOGNIZED')
    expect(parseZhejiangTaxProfile(basic, {
      ...noRows, emptyRecognitions: true,
    }, expected, now)).toMatchObject({ obligations: [], obligationCoverage: 'visible_page' })
  })
})
