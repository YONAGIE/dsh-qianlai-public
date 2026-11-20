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
  taxAuthority: '合成主管税务机关',
  incomeMethod: '查账征收',
  accountingSystem: '小企业会计准则',
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

function ready(wizard: CompanyOnboarding, company = enterprise, books = accounting, payrollSetup = payroll) {
  let view = accepted(wizard.save(1, wizard.status().revision, company))
  view = accepted(wizard.save(2, view.revision, books))
  return accepted(wizard.save(3, view.revision, payrollSetup))
}

describe('企业建档', () => {
  it('扫码与手动填写来回切换时保留当前草稿、已填银行账户和步骤', () => {
    const { store, wizard } = setup()
    const draft = accepted(wizard.save(1, wizard.status().revision, enterprise))
    const scan = accepted(wizard.setMode(draft.revision, 'scan'))
    const reopened = new CompanyOnboarding(store, now)
    const manual = accepted(reopened.setMode(scan.revision, 'manual'))

    expect(manual).toMatchObject({ draftId: draft.draftId, step: 2, mode: 'manual', enterprise: draft.enterprise })
    expect(reopened.setMode(scan.revision, 'scan')).toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
    expect(reopened.status()).toEqual(manual)
  })

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

  it('侧栏修改同一企业时，保留其他分组并防止旧编辑覆盖', () => {
    const { store, wizard } = setup()
    const review = ready(wizard)
    const account = review.enterprise!.accounts[0]!
    const { maskedNumber, ...editable } = account
    expect(maskedNumber).toBe('尾号 0002')
    const name = '样例软件服务（更正版）有限公司'
    const renamed = accepted(wizard.editSection(review.revision, 'company', { companyName: name }))
    const bank = accepted(wizard.editSection(renamed.revision, 'bank', { accounts: [{ ...editable, bank: '更正后的银行' }] }))
    expect(bank).toMatchObject({
      step: 4, accounting, payroll,
      enterprise: { companyName: name, taxId: enterprise.taxId, accounts: [expect.objectContaining({ maskedNumber, bank: '更正后的银行' })] },
    })
    expect(store.companyOnboarding()?.enterprise?.accounts[0]?.number).toBe(enterprise.accounts[0]!.number)
    expect(wizard.editSection(review.revision, 'company', { establishedOn: '2024-01-03' })).toMatchObject({ code: 'DRAFT_STALE' })
    expect(wizard.editSection(bank.revision, 'company', { accounts: [] })).toMatchObject({ code: 'DRAFT_INPUT_INVALID' })
    expect(wizard.editSection(bank.revision, 'bank', { accounts: [{ ...editable, number: maskedNumber }] })).toMatchObject({ code: 'BANK_NUMBER_INVALID' })
    expect(wizard.editSection(bank.revision, 'company', { taxId: '000000000000000003' })).toMatchObject({ code: 'COMPANY_ACCOUNT_MISMATCH' })
    expect(wizard.status()).toEqual(bank)
  })

  it('侧栏可补后续分组，保存后仍从最早缺项继续，更换信用代码时重新核对税务', () => {
    const { wizard } = setup()
    const draft = accepted(wizard.editSection(0, 'payroll', payroll))
    expect(draft).toMatchObject({ step: 1, payroll, completed: false })
    const entered = accepted(wizard.save(1, draft.revision, { ...enterprise, bankStatus: 'none', accounts: [] }))
    const changed = accepted(wizard.editSection(entered.revision, 'company', { taxId: '000000000000000003' }))
    expect(changed).toMatchObject({
      step: 1, enterprise: { taxId: '000000000000000003', province: '', city: '', taxStatus: '', taxpayerIdentity: '' },
    })
    expect(changed).not.toHaveProperty('payroll')
  })

  it.each([
    [{ taxpayerIdentity: 'general' }, 'ENTERPRISE_UNSUPPORTED'],
    [{ taxStatus: '非正常' }, 'ENTERPRISE_UNSUPPORTED'],
    [{ business: ['cross-border'] }, 'ENTERPRISE_UNSUPPORTED'],
    [{ business: [] }, 'BUSINESS_REQUIRED'],
    [{ bankStatus: 'provided', accounts: [] }, 'BANK_ACCOUNT_REQUIRED'],
  ])('明确判断企业是否能承接（%j）', (patch, code) => {
    const { wizard } = setup()
    expect(wizard.save(1, 0, { ...enterprise, ...patch })).toMatchObject({ accepted: false, code })
    const draft = accepted(wizard.save(1, 0, { ...enterprise, ...patch }, false))
    expect(draft.step).toBe(1)
  })

  it('拒绝新增互斥的实际经营选项，同时保留旧草稿的具体经营项供更正', () => {
    const { store, wizard } = setup()
    expect(wizard.save(1, 0, { ...enterprise, business: ['goods', 'none'] }, false))
      .toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    const draft = accepted(wizard.save(1, 0, enterprise, false))
    const stored = store.companyOnboarding()!
    stored.enterprise!.business = ['goods', 'none']
    store.saveCompanyOnboarding(stored)
    expect(wizard.status()).toMatchObject({ revision: draft.revision, enterprise: { business: ['goods'] } })
    const updated = accepted(wizard.editSection(draft.revision, 'company', { business: ['none'] }))
    expect(updated.enterprise?.business).toEqual(['none'])
  })

  it('先保存税务草稿，补齐必填项后再完成建档', () => {
    const { store, wizard } = setup()
    const pending = { ...enterprise, taxpayerIdentity: 'unknown', bankStatus: 'pending', accounts: [] }
    expect(wizard.save(1, 0, pending)).toMatchObject({ accepted: false, code: 'TAX_DETAILS_REQUIRED' })
    const draft = accepted(wizard.save(1, 0, pending, false))
    expect(draft).toMatchObject({ step: 1, completed: false, enterprise: { bankStatus: 'pending' } })
    expect(store.company()).toBeUndefined()
    const review = ready(wizard, { ...pending, taxpayerIdentity: 'small-scale' })
    expect(wizard.confirm(review.revision, false)).toMatchObject({ accepted: true, completed: true })
  })

  it('旧草稿返回缺少的税务资料，保留账户、账期和已完成账本', () => {
    const { store, wizard } = setup()
    const review = ready(wizard)
    const old = store.companyOnboarding()!
    delete old.enterprise!.incomeMethod
    delete old.enterprise!.accountingSystem
    old.enterprise!.taxStatus = '旧版自定义状态'
    store.saveCompanyOnboarding(old)
    expect(wizard.status()).toMatchObject({ step: 1, accounting, payroll, enterprise: {
      taxStatus: '其他', taxStatusOther: '旧版自定义状态', incomeMethod: '', accountingSystem: '', accounts: [{ holder: enterprise.accounts[0]!.holder }],
    } })
    expect(wizard.confirm(review.revision, false)).toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
    const fixed = ready(wizard)
    expect(wizard.confirm(fixed.revision, false)).toMatchObject({ accepted: true, completed: true })
    const completed = store.companyOnboarding()!
    delete completed.enterprise!.incomeMethod
    delete completed.enterprise!.accountingSystem
    store.saveCompanyOnboarding(completed)
    expect(wizard.status()).toMatchObject({ completed: true, step: 4 })
    expect(store.company()).toMatchObject({ name: enterprise.companyName })
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
    expect(wizard.editSection(fetched.revision, 'tax', { province: '北京市', city: '北京市' }))
      .toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    expect(wizard.editSection(fetched.revision, 'tax', { taxAuthority: '人工替换的机构' }))
      .toMatchObject({ accepted: false, code: 'DRAFT_INPUT_INVALID' })
    expect(wizard.status()).toEqual(fetched)
    expect(wizard.save(1, fetched.revision, { ...enterprise, city: '嘉兴市' }))
      .toMatchObject({ accepted: false, code: 'ENTERPRISE_UNSUPPORTED' })
  })

  it('旧账与起账有空档时在复核和接账环节明确提示', () => {
    const { store, wizard } = setup()
    const review = ready(wizard, enterprise, { ...accounting, lastMonth: '2026-09' })
    expect(review.handoffWarning).toContain('空档')
    expect(wizard.confirm(review.revision, false)).toMatchObject({ completed: true, nextAction: 'review-book-periods' })
    expect(onboardingBookStatus(store)).toMatchObject({
      history: 'previous', lastMonth: '2026-09', payroll, nextAction: 'review-book-periods',
      handoff: { kind: 'review-book-periods', gapFrom: '2026-10', gapTo: '2026-10' },
    })
    expect(JSON.stringify(onboardingBookStatus(store))).not.toContain(enterprise.taxId)
    expect(store.companyFacts()).toEqual({})
    expect(store.openingBalancesSetAt()).toBeUndefined()
  })

  it.each([
    { history: 'previous', lastMonth: '2026-10', handoff: { kind: 'prior-period-balances', statementMonth: '2026-10', attachment: '添加科目余额表' } },
    { history: 'unrecorded', lastMonth: '', handoff: { kind: 'reconstruct-opening-balances', openingMonth: '2026-11', attachment: '添加银行对账单' } },
    { history: 'new', lastMonth: '', handoff: { kind: 'confirm-opening-balances', openingMonth: '2026-11' } },
  ])('根据旧账情况 $history 引导期初接账，保留实际账本进度', ({ history, lastMonth, handoff }) => {
    const { store, wizard } = setup()
    const review = ready(wizard, enterprise, { history, lastMonth, startMonth: '2026-11' })
    expect(wizard.confirm(review.revision, false)).toMatchObject({ completed: true, handoff })
    expect(onboardingBookStatus(store)).toMatchObject({ completed: true, handoff })
    expect(store.openingBalancesSetAt()).toBeUndefined()

    store.setOpeningBalances([], now())
    const done = { completed: true, nextAction: 'bookkeeping', handoff: { kind: 'bookkeeping' } }
    expect(wizard.status()).toMatchObject(done)
    expect(onboardingBookStatus(store)).toMatchObject(done)
  })

  it('已登记暂不发工资和无参保时减少常规索件，已有账务事实优先', () => {
    const { store, wizard } = setup()
    const review = ready(wizard, enterprise, accounting, { payroll: 'none', social: 'none' })
    expect(wizard.confirm(review.revision, false)).toMatchObject({ completed: true })
    expect(onboardingBookStatus(store)).toMatchObject({ routineMaterialExclusions: ['工资表', '社保缴费凭证'] })
    expect(store.companyFacts()).toEqual({})

    store.setCompanyFact('entity.has_payroll', 'yes')
    expect(onboardingBookStatus(store)).toMatchObject({ routineMaterialExclusions: [] })
    expect(store.companyFacts()).toEqual({ 'entity.has_payroll': 'yes' })
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

describe('已完成的企业档案', () => {
  const number = '620000000000001001'
  const firstAccount = { ...enterprise.accounts[0]!, number }
  const secondAccount = { ...firstAccount, bank: '另一家样例银行', number: '930000000000002002' }

  function completed(accounts = [firstAccount]) {
    const { store, wizard } = setup()
    return { store, wizard, original: accepted(wizard.confirm(ready(wizard, { ...enterprise, accounts }).revision, false)) }
  }

  function edit(wizard: CompanyOnboarding, field: string, values?: Record<string, unknown>, oldTail?: string, session = 'owner-chat') {
    const result = wizard.guide(session, 'edit-profile', [field], values, undefined, undefined, oldTail)
    if (!result.accepted || !('card' in result) || result.card?.kind !== 'fields') throw Error('未取得企业档案更正卡')
    return result.card
  }

  it('已完成建档的企业按当前会话确认补登记，只保存尾号，且不改发薪安排', () => {
    const { store, wizard } = setup()
    const existing = accepted(wizard.confirm(ready(wizard, { ...enterprise, bankStatus: 'pending', accounts: [] }).revision, false))
    const fields = { holder: enterprise.companyName, accountTail: '0080', bank: '合成登记银行', currency: 'CNY', openedOn: '2026-11-06' }
    const visible = wizard.guide('owner-chat', 'add-bank-account', undefined, fields)
    if (!visible.accepted || !('card' in visible) || !visible.card) throw Error('未取得登记卡')
    expect(store.companyOnboarding()?.enterprise?.bankStatus).toBe('pending')
    const { id, revision } = visible.card
    expect(wizard.submitCard('other-session', id, revision, undefined, fields)).toMatchObject({ accepted: false })
    expect(wizard.submitCard('owner-chat', id, revision, undefined, { ...fields, holder: '另一家合成企业' }))
      .toMatchObject({ accepted: false, code: 'PROFILE_ACCOUNT_OWNER_MISMATCH' })
    expect(wizard.submitCard('owner-chat', id, revision, undefined, fields))
      .toMatchObject({ accepted: true, receipt: { choice: 'account-added' }, view: { completedAt: existing.completedAt, payroll,
        enterprise: { bankStatus: 'provided', accounts: [{ maskedNumber: '尾号 0080' }] },
      } })
    expect(store.companyOnboarding()?.enterprise?.accounts[0]?.number).toBe(fields.accountTail)
    expect(store.statementCoverage()).toEqual([])
  })

  it('重复更正成立日期时打开新卡，旧回执按最新档案重新打开', () => {
    const { wizard, store } = completed()
    const session = 'owner-chat'
    const first = edit(wizard, 'establishedOn', { establishedOn: '2025-03-01' })
    const repeated = edit(wizard, 'establishedOn', { establishedOn: '2025-03-01' })
    expect(repeated.id).not.toBe(first.id)
    expect(wizard.cardStatus(session, first.id)).toMatchObject({ stale: true, cardState: 'stale' })
    expect(wizard.cardStatus(session, repeated.id)).toMatchObject({ cardState: 'active' })
    expect(wizard.submitCard(session, first.id, first.revision, undefined, { establishedOn: '2025-03-01' }))
      .toMatchObject({ accepted: false, code: 'DRAFT_STALE' })
    expect(store.companyOnboarding()?.enterprise?.establishedOn).toBe(enterprise.establishedOn)
    expect(wizard.submitCard(session, repeated.id, repeated.revision, undefined, { establishedOn: '2025-03-02' }))
      .toMatchObject({ accepted: true, cardState: 'saved', receipt: { labels: ['成立日期'] } })

    const later = edit(wizard, 'establishedOn')
    expect(wizard.submitCard(session, later.id, later.revision, undefined, { establishedOn: '2025-03-03' }))
      .toMatchObject({ accepted: true, cardState: 'saved' })
    expect(wizard.reopenProfileCard('another-chat', repeated.id)).toMatchObject({ accepted: false, code: 'CARD_UNAVAILABLE' })
    const reopened = wizard.reopenProfileCard(session, repeated.id)
    if (!reopened.accepted || !('card' in reopened)) throw Error('未重新打开企业档案更正卡')
    expect(reopened).toMatchObject({
      cardState: 'active', card: { maintenance: { field: 'establishedOn' }, initialValues: { establishedOn: '2025-03-03' } },
    })
    expect(reopened.card.id).not.toBe(repeated.id)
    expect(wizard.cardStatus(session, repeated.id)).toMatchObject({ cardState: 'saved' })
    expect(store.companyOnboarding()?.enterprise?.establishedOn).toBe('2025-03-03')
  })

  it('更正尾号只在原会话确认后写库，保留完整账号的前缀、前导零和已建的账本', () => {
    const { store, wizard, original } = completed()
    const card = edit(wizard, 'accountTail', { accountTail: '0001' }, '1001')
    const current = () => wizard.guide('owner-chat', 'read-profile', ['bankAccounts'])
    expect(current()).toEqual({ accepted: true, completed: true, field: 'bankAccounts', label: '已登记的银行账户', value: ['样例银行 尾号 1001'] })
    expect(wizard.cardStatus('another-chat', card.id)).toMatchObject({ stale: true })
    expect(card).toMatchObject({ fields: [{ key: 'accountTail' }], initialValues: { accountTail: '0001' } })
    expect(JSON.stringify(card)).not.toContain(number)
    expect(wizard.submitCard('owner-chat', card.id, card.revision, undefined, { accountTail: '001' }))
      .toMatchObject({ accepted: false, code: 'PROFILE_ACCOUNT_TAIL_INVALID' })
    expect(wizard.submitCard('owner-chat', card.id, card.revision, undefined, { accountTail: '0001', social: 'all' }))
      .toMatchObject({ accepted: false, code: 'PROFILE_INPUT_INVALID' })
    const updated = wizard.submitCard('owner-chat', card.id, card.revision, undefined, { accountTail: '0001' })
    expect(updated).toMatchObject({ accepted: true, receipt: { labels: ['银行账号尾号'] },
      view: { completed: true, completedAt: original.completedAt, payroll, accounting, enterprise: {
        accounts: [{ maskedNumber: '尾号 0001' }],
      } } })
    expect(store.companyOnboarding()?.enterprise?.accounts[0]?.number).toBe(number.slice(0, -4) + '0001')
    expect(current()).toMatchObject({ value: ['样例银行 尾号 0001'] })
    expect(onboardingBookStatus(store)).toMatchObject({ completed: true, confirmedAccountLabels: ['样例银行 尾号 0001'] })
    expect(wizard.submitCard('owner-chat', card.id, card.revision, undefined, { accountTail: '9999' })).toEqual(updated)
    expect(wizard.guide('owner-chat', 'continue')).toEqual({ accepted: true, completed: true })
    const reopened = wizard.reopenProfileCard('owner-chat', card.id)
    expect(reopened).toMatchObject({
      cardState: 'active', card: { maintenance: { field: 'accountTail' }, initialValues: { accountTail: '0001' } },
    })
    expect(JSON.stringify(reopened)).not.toContain(number.slice(0, -4))
  })

  it('多账户在同一张卡内先选择账户，拒绝重复尾号及并行窗口的旧卡', () => {
    const { wizard, store } = completed([firstAccount, secondAccount])
    const oldCard = edit(wizard, 'social', { social: 'all' }, undefined, 'other-chat')
    const card = edit(wizard, 'accountTail', { accountTail: '2002' })
    const choices = card.fields[0]?.options
    expect(choices?.map(option => option.label)).toEqual([
      expect.stringContaining('样例银行 尾号 1001'), expect.stringContaining('另一家样例银行 尾号 2002'),
    ])
    const selected = wizard.submitCard('owner-chat', card.id, card.revision, undefined, { accountChoice: choices?.[0]?.value })
    if (!selected.accepted || !('card' in selected) || !selected.card) throw Error('未取得同一张更正卡')
    expect(selected).toMatchObject({ incomplete: true, card: { id: card.id, initialValues: { accountTail: '2002' } } })
    expect(store.companyOnboarding()?.enterprise?.accounts[0]?.number).toBe(number)
    expect(wizard.submitCard('owner-chat', card.id, selected.card.revision, undefined, { accountTail: '2002' }))
      .toMatchObject({ code: 'PROFILE_ACCOUNT_TAIL_COLLIDES' })
    expect(wizard.submitCard('owner-chat', card.id, selected.card.revision, undefined, { accountTail: '0001' }))
      .toMatchObject({ accepted: true })
    expect(store.companyOnboarding()?.enterprise?.accounts[1]?.number).toBe(secondAccount.number)
    expect(wizard.submitCard('other-chat', oldCard.id, oldCard.revision, undefined, { social: 'all' }))
      .toMatchObject({ code: 'DRAFT_STALE' })
  })

  it('有关联流水时阻止更改账户标识，保留已导入数据', () => {
    const { wizard, store } = completed()
    const card = edit(wizard, 'accountTail', { accountTail: '0001' })
    const label = '样例银行 尾号 001001'
    store.importStatement({ accountRef: label, periodStart: '2026-11-01', periodEnd: '2026-11-16', openingBalanceCents: 0n, lines: [], now: now() })
    expect(wizard.submitCard('owner-chat', card.id, card.revision, undefined, { accountTail: '0001' }))
      .toMatchObject({ accepted: false, code: 'PROFILE_ACCOUNT_HAS_STATEMENTS' })
    expect(store.companyOnboarding()?.enterprise?.accounts[0]?.number).toBe(number)
    expect(store.statementCoverage()[0]?.accountRef).toBe(label)
  })

  it('只读取所问字段，维护公司名和工资社保时保留原账及其他资料', () => {
    const { wizard, store } = completed()
    store.setOpeningBalances([], now())
    const name = '样例更正企业有限公司'
    const companyCard = edit(wizard, 'companyName', { companyName: name })
    expect(wizard.submitCard('owner-chat', companyCard.id, companyCard.revision, undefined, { companyName: name })).toMatchObject({ accepted: true })
    expect(wizard.guide('owner-chat', 'read-profile', ['companyName']))
      .toEqual({ accepted: true, completed: true, field: 'companyName', label: '企业全称', value: name })
    expect(wizard.guide('owner-chat', 'read-profile', ['taxId'])).toMatchObject({ value: '尾号 0001' })
    const payrollCard = edit(wizard, 'payroll', { payroll: 'scheduled', payday: '9' })
    expect(payrollCard.initialValues).toEqual({ payroll: '9' })
    expect(wizard.submitCard('owner-chat', payrollCard.id, payrollCard.revision, undefined, { payroll: '9' }))
      .toMatchObject({ view: { payroll: { payroll: 'scheduled', payday: 9, social: 'partial' }, accounting } })
    expect(store.company()).toMatchObject({ name, taxId: enterprise.taxId, accountingStartMonth: accounting.startMonth })
    expect(store.openingBalancesSetAt()).toBe(now().toISOString())
    expect(wizard.guide('owner-chat', 'edit-profile', ['taxId'])).toMatchObject({ accepted: false, code: 'PROFILE_FIELD_LOCKED' })
    expect(wizard.guide('owner-chat', 'edit-profile', ['social', 'payday'])).toMatchObject({ accepted: false, code: 'PROFILE_FIELD_REQUIRED' })
  })

  it('读取未完成档案时不创建草稿', () => {
    const { wizard, store } = setup()
    expect(wizard.guide('owner-chat', 'read-profile', ['companyName'])).toMatchObject({ accepted: false, code: 'PROFILE_UNAVAILABLE' })
    expect(store.companyOnboarding()).toBeUndefined()
  })
})
