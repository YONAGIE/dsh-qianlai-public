import { mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkOnboardingBookOpen, CompanyOnboarding, onboardingBookStatus, type OnboardingView } from '../src/company-onboarding.js'
import { BookStore } from '../src/store.js'
import type { TaxProfile } from '../src/tax-portal.js'

const now = () => new Date('2026-11-16T08:00:00Z')
const enterprise = {
  companyName: '样例软件服务有限公司',
  taxId: '000000000000000001',
  establishedOn: '2025-12-14',
  province: '浙江省',
  city: '杭州市',
  taxpayerIdentity: 'small-scale',
  taxStatus: '正常',
  taxAuthority: '',
  business: ['none'],
  bankStatus: 'provided',
  accounts: [{ holder: '样例软件服务有限公司', number: '000000000000000002', bank: '样例银行', currency: 'CNY', openedOn: '' }],
}
const accounting = { history: 'previous', lastMonth: '2026-10', startMonth: '2026-11' }
const payroll = { payroll: 'none', social: 'partial' }

const stores: BookStore[] = []
function setup(path = ':memory:') {
  const store = new BookStore(path)
  stores.push(store)
  return { store, wizard: new CompanyOnboarding(store, now) }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function accepted(result: ReturnType<CompanyOnboarding['save']>): OnboardingView {
  if (!result.accepted) throw Error(`${result.code}: ${result.message}`)
  return result
}

function ready(wizard: CompanyOnboarding, company = enterprise, books = accounting) {
  let view = accepted(wizard.save(1, wizard.status().revision, company))
  view = accepted(wizard.save(2, view.revision, books))
  return accepted(wizard.save(3, view.revision, payroll))
}

describe('企业建档', () => {
  it('在关闭并重开账本后恢复草稿，并拒绝旧窗口覆盖', () => {
    const directory = mkdtempSync(join(tmpdir(), 'company-onboarding-'))
    const path = join(directory, 'book.sqlite')
    let store = new BookStore(path)
    try {
      const first = new CompanyOnboarding(store, now)
      const initial = first.status()
      const saved = accepted(first.save(1, initial.revision, { companyName: enterprise.companyName }, false))
      expect(saved).toMatchObject({ step: 1, draftId: initial.draftId, enterprise: { companyName: enterprise.companyName } })
      store.close()
      store = new BookStore(path)
      const reopened = new CompanyOnboarding(store, now)
      expect(reopened.status()).toEqual(saved)
      expect(reopened.save(1, initial.revision, { companyName: '旧窗口' }, false))
        .toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
      expect(reopened.save(2, saved.revision, accounting)).toMatchObject({ accepted: false, code: 'STEP_UNAVAILABLE' })
    } finally {
      store.close()
      rmSync(path)
      rmdirSync(directory)
    }
  })

  it('保留账户脱敏标识并用稳定账户 ID 保留已录号码', () => {
    const { store, wizard } = setup()
    const first = accepted(wizard.save(1, 0, enterprise))
    expect(first.enterprise?.accounts[0]).toMatchObject({ maskedNumber: '尾号 0002' })
    expect(JSON.stringify(first)).not.toContain(enterprise.accounts[0]!.number)
    const edited = { ...first.enterprise, accounts: first.enterprise!.accounts.map(account => ({ ...account, bank: '更正后的银行' })) }
    expect(wizard.save(1, first.revision, edited)).toMatchObject({ accepted: true, step: 2 })
    expect(store.companyOnboarding()?.enterprise?.accounts[0]).toMatchObject({ number: enterprise.accounts[0]!.number, bank: '更正后的银行' })
    expect(wizard.save(1, wizard.status().revision, { ...edited, taxId: '000000000000000003' }))
      .toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
  })

  it.each([
    [{ taxpayerIdentity: 'general' }, 'ENTERPRISE_UNSUPPORTED'],
    [{ taxStatus: '非正常' }, 'ENTERPRISE_UNSUPPORTED'],
    [{ business: ['cross-border', 'none'] }, 'ENTERPRISE_UNSUPPORTED'],
    [{ business: [] }, 'BUSINESS_REQUIRED'],
    [{ bankStatus: 'provided', accounts: [] }, 'BANK_ACCOUNT_REQUIRED'],
  ])('明确判断企业是否能承接（%j）', (patch, code) => {
    const { wizard } = setup()
    expect(wizard.save(1, 0, { ...enterprise, ...patch })).toMatchObject({ accepted: false, code })
    const draft = accepted(wizard.save(1, 0, { ...enterprise, ...patch }, false))
    expect(draft.step).toBe(1)
  })

  it('待核实税务身份保存资料，完成建档前须补足身份', () => {
    const { store, wizard } = setup()
    const review = ready(wizard, { ...enterprise, taxpayerIdentity: 'unknown', bankStatus: 'pending', accounts: [] })
    expect(wizard.confirm(review.revision, false)).toMatchObject({ accepted: false, code: 'TAX_IDENTITY_UNCONFIRMED' })
    expect(store.company()).toBeUndefined()
    expect(wizard.status()).toMatchObject({ step: 4, completed: false, enterprise: { bankStatus: 'pending' } })
    const fixed = accepted(wizard.save(1, review.revision, { ...enterprise, bankStatus: 'pending', accounts: [] }))
    expect(fixed.step).toBe(4)
    expect(wizard.confirm(fixed.revision, false)).toMatchObject({ accepted: true, completed: true })
  })

  it('把官方查询结果关联到当前草稿，且只允许补未取得的字段', () => {
    const { wizard } = setup()
    const entered = accepted(wizard.save(1, 0, enterprise, false))
    const profile: TaxProfile = {
      companyName: '样例 软件服务有限公司', taxId: enterprise.taxId,
      authority: '杭州市税务局', taxpayerQualification: '一般纳税人', registrationStatus: '待核实',
      obligations: [], obligationCoverage: 'visible_page', observedAt: now().toISOString(),
      sourceUrl: 'https://etax.zhejiang.chinatax.gov.cn/tax',
    }
    expect(wizard.applyTaxProfile('other-draft', enterprise.province, enterprise.city, profile))
      .toMatchObject({ accepted: false, code: 'TAX_DRAFT_CHANGED' })
    const fetched = accepted(wizard.applyTaxProfile(entered.draftId, enterprise.province, enterprise.city, profile))
    expect(fetched.enterprise?.officialTax).toMatchObject({
      taxpayerIdentity: 'general', taxStatus: '', sourceUrl: profile.sourceUrl, observedAt: profile.observedAt,
    })
    expect(wizard.save(1, fetched.revision, { ...enterprise, city: '嘉兴市' }))
      .toMatchObject({ accepted: false, code: 'ENTERPRISE_UNSUPPORTED' })
  })

  it('旧账与起账有空档时在复核和接账环节明确提示', () => {
    const { store, wizard } = setup()
    const review = ready(wizard, enterprise, { ...accounting, lastMonth: '2026-09' })
    expect(review.handoffWarning).toContain('空档')
    expect(wizard.confirm(review.revision, false)).toMatchObject({ completed: true, nextAction: 'review-book-periods' })
    expect(onboardingBookStatus(store)).toMatchObject({ history: 'previous', lastMonth: '2026-09', payroll, nextAction: 'review-book-periods' })
    expect(JSON.stringify(onboardingBookStatus(store))).not.toContain(enterprise.taxId)
    expect(store.companyFacts()).toEqual({})
    expect(store.openingBalancesSetAt()).toBeUndefined()
  })

  it('阻止起账月覆盖已完成的旧账月份', () => {
    const { store, wizard } = setup()
    const draft = accepted(wizard.save(1, 0, enterprise))
    const overlapping = { ...accounting, lastMonth: '2026-11' }
    expect(wizard.save(2, draft.revision, overlapping)).toMatchObject({ accepted: false, code: 'BOOK_PERIOD_OVERLAP' })
    const saved = accepted(wizard.save(2, draft.revision, overlapping, false))
    expect(saved.step).toBe(2)
    expect(wizard.confirm(saved.revision, true)).toMatchObject({ accepted: false, code: 'STEP_UNAVAILABLE' })
    expect(store.company()).toBeUndefined()
  })

  it('已有同一企业建档草稿时引导旧开账入口继续建档', () => {
    const { store, wizard } = setup()
    expect(checkOnboardingBookOpen(store, enterprise.companyName)).toBeUndefined()
    expect(checkOnboardingBookOpen(store, '')).toBeUndefined()
    const draft = accepted(wizard.save(1, 0, { ...enterprise, taxpayerIdentity: 'general' }, false))
    expect(checkOnboardingBookOpen(store, '样例 软件服务有限公司')).toMatchObject({ code: 'ONBOARDING_IN_PROGRESS' })
    expect(checkOnboardingBookOpen(store, '别称', enterprise.taxId)).toMatchObject({ code: 'ONBOARDING_IN_PROGRESS' })
    expect(checkOnboardingBookOpen(store, '另一家企业', '000000000000000003')).toBeUndefined()
    expect(wizard.status()).toEqual(draft)
    const review = ready(wizard)
    expect(wizard.confirm(review.revision, false)).toMatchObject({ accepted: true, completed: true })
    expect(checkOnboardingBookOpen(store, enterprise.companyName, enterprise.taxId)).toBeUndefined()
  })

  it('明确同意后替换样本账，重复确认复用同一结果', () => {
    const { store, wizard } = setup()
    store.createCompany({ name: '样本企业', accountingStartMonth: '2026-01', isSample: true })
    store.setCompanyFact('sample', 'yes')
    const review = ready(wizard)
    expect(review.replacesSampleBook).toBe(true)
    expect(wizard.confirm(review.revision, false)).toMatchObject({ accepted: false, code: 'CONFIRM_REQUIRED' })
    expect(store.companyFacts()).toEqual({ sample: 'yes' })
    const done = accepted(wizard.confirm(review.revision, true))
    expect(done).toMatchObject({ completed: true, nextAction: 'opening-balances', replacesSampleBook: false })
    expect(store.company()).toMatchObject({ name: enterprise.companyName, accountingStartMonth: accounting.startMonth, isSample: false })
    expect(store.companyFacts()).toEqual({})
    expect(wizard.confirm(review.revision, true)).toEqual(done)
  })

  it('完成记录保存失败时撤销开账并保留原样本账和草稿', () => {
    const { store, wizard } = setup()
    store.createCompany({ name: '样本企业', accountingStartMonth: '2026-01', isSample: true })
    const review = ready(wizard)
    const failedSave = vi.spyOn(store, 'saveCompanyOnboarding').mockImplementationOnce(() => {
      throw Error('synthetic write error')
    })
    try {
      expect(() => wizard.confirm(review.revision, true)).toThrow('synthetic write error')
      expect(store.company()).toMatchObject({ name: '样本企业', isSample: true })
      expect(wizard.status()).toEqual(review)
    } finally {
      failedSave.mockRestore()
    }
  })

  it('拒绝更换正式账本的身份或期间，完全匹配时只附加建档资料', () => {
    const { store, wizard } = setup()
    store.createCompany({
      name: enterprise.companyName, taxId: enterprise.taxId, accountingStartMonth: accounting.startMonth, isSample: false,
    })
    store.setCompanyFact('prior-confirmation', 'yes')
    store.setOpeningBalances([], now())
    const review = ready(wizard, enterprise, { ...accounting, startMonth: '2026-12' })
    expect(wizard.confirm(review.revision, true)).toMatchObject({ accepted: false, code: 'BOOK_EXISTS' })
    const fixed = accepted(wizard.save(2, review.revision, accounting))
    expect(wizard.confirm(fixed.revision, false)).toMatchObject({ completed: true, nextAction: 'bookkeeping' })
    expect(store.companyFacts()).toEqual({ 'prior-confirmation': 'yes' })
    expect(store.openingBalancesSetAt()).toBe(now().toISOString())
  })
})
