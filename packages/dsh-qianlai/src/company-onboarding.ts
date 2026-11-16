import { randomUUID } from 'node:crypto'

import { openBook } from './book.js'
import { isCalendarDate, PERIOD_KEY, previousPeriod, refuse, todayInChina, type Refusal } from './period.js'
import type { BookStore } from './store.js'
import regions from './tax-regions.json' with { type: 'json' }
import type { TaxProfile } from './tax-portal.js'

type Step = 1 | 2 | 3 | 4
type EditableStep = Exclude<Step, 4>
export type OnboardingMode = 'scan' | 'manual'
type TaxpayerIdentity = 'small-scale' | 'general' | 'unknown'
type Business = 'goods' | 'production' | 'cross-border' | 'multiple-entities' | 'none'
type BankStatus = 'provided' | 'none' | 'pending'
type History = 'previous' | 'unrecorded' | 'new'
type PayrollMode = 'scheduled' | 'none'
type SocialMode = 'all' | 'partial' | 'none' | 'unknown'

interface Account {
  id: string
  holder: string
  number: string
  bank: string
  currency: string
  openedOn: string
}

interface OfficialTax {
  province: string
  city: string
  taxpayerIdentity: TaxpayerIdentity
  taxStatus: string
  taxAuthority: string
  obligations: TaxProfile['obligations']
  obligationCoverage: TaxProfile['obligationCoverage']
  observedAt: string
  sourceUrl: string
}

interface Enterprise {
  companyName: string
  taxId: string
  establishedOn: string
  province: string
  city: string
  taxpayerIdentity: TaxpayerIdentity | ''
  taxStatus: string
  taxAuthority: string
  business: Business[]
  bankStatus: BankStatus | ''
  accounts: Account[]
  officialTax?: OfficialTax
}

interface Accounting {
  history: History | ''
  lastMonth: string
  startMonth: string
}

interface Payroll {
  payroll: PayrollMode | ''
  payday?: number
  social: SocialMode | ''
}

export interface OnboardingRecord {
  draftId: string
  revision: number
  step: Step
  mode?: OnboardingMode
  enterprise?: Enterprise
  accounting?: Accounting
  payroll?: Payroll
  completedAt?: string
}

type NextAction = 'review-book-periods' | 'opening-balances' | 'bookkeeping'

export interface OnboardingView extends Omit<OnboardingRecord, 'enterprise'> {
  accepted: true
  completed: boolean
  replacesSampleBook: boolean
  enterprise?: Omit<Enterprise, 'accounts'> & { accounts: (Omit<Account, 'number'> & { maskedNumber?: string })[] }
  nextAction?: NextAction
  handoffWarning?: string
}

const TAX_ID = /^[0-9A-Z]{18}$/
const cities: Readonly<Record<string, readonly string[]>> = regions
const identities = ['small-scale', 'general', 'unknown'] as const
const blockedStatuses = ['非正常', '注销', '非正常注销', '停业', '清算'] as const
const businessLabels = {
  goods: '买卖商品或有库存',
  production: '生产或加工产品',
  'cross-border': '有境外客户、供应商或用外币收付款',
  'multiple-entities': '有分公司或多个经营主体',
  none: '以上都没有',
} as const
const choices = Object.keys(businessLabels) as Business[]
const normalizeCompanyName = (name: string) => name.normalize('NFKC').replace(/\s+/g, '')

function isBlockedStatus(value: string) {
  return blockedStatuses.some(status => status === value.trim())
}

class InputError extends Error {}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('没有收到可保存的资料，请重新填写。')
  return input as Record<string, unknown>
}

function text(input: unknown, label: string, max = 200): string {
  if (input === undefined || input === '') return ''
  if (typeof input !== 'string' || input.length > max || /\p{Cc}|\p{Cf}/u.test(input))
    throw new InputError(`${label}格式不正确。`)
  return input.trim()
}

function select<Value extends string>(input: unknown, values: readonly Value[], label: string): Value | '' {
  if (input === undefined || input === '') return ''
  const choice = values.find(value => value === input)
  if (!choice) throw new InputError(`请重新选择${label}。`)
  return choice
}

function parseAccounts(input: unknown, previous: readonly Account[]): Account[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 20) throw new InputError('请核对银行账户列表，最多可填写 20 个账户。')
  const ids = new Set<string>()
  return input.map((item: unknown) => {
    const entry = object(item)
    const id = text(entry.id, '账户标识', 40)
    const saved = id ? previous.find(account => account.id === id) : undefined
    if (id && (!saved || ids.has(id))) throw new InputError('账户列表已变化，请刷新后重试。')
    if (id) ids.add(id)
    return {
      id: id || randomUUID(),
      holder: text(entry.holder, '账户户名'),
      number: text(entry.number, '银行账号', 48).replace(/[ -]/g, '') || saved?.number || '',
      bank: text(entry.bank, '开户行'),
      currency: text(entry.currency, '币种', 3).toUpperCase(),
      openedOn: text(entry.openedOn, '开户日期', 10),
    }
  })
}

function parseEnterprise(input: unknown, previous?: Enterprise): Enterprise {
  const data = object(input)
  const companyName = text(data.companyName, '企业全称')
  const taxId = text(data.taxId, '统一社会信用代码', 18).toUpperCase()
  const province = text(data.province, '省份', 30)
  const city = text(data.city, '城市或地区', 50)
  const officialTax = taxId && previous?.taxId === taxId ? previous.officialTax : undefined
  if (officialTax && previous && normalizeCompanyName(previous.companyName) !== normalizeCompanyName(companyName))
    throw new InputError('企业名称与同一信用代码的已读取税务资料不一致，请核对后再填。')
  const selected = data.business ?? []
  if (!Array.isArray(selected) || selected.length > choices.length || selected.some(value => !choices.includes(value as Business)))
    throw new InputError('请重新选择企业的实际经营情况。')
  const bankStatus = select(data.bankStatus, ['provided', 'none', 'pending'], '账户情况')
  return {
    companyName, taxId, province, city,
    establishedOn: text(data.establishedOn, '成立日期', 10),
    taxpayerIdentity: officialTax && officialTax.taxpayerIdentity !== 'unknown'
      ? officialTax.taxpayerIdentity : select(data.taxpayerIdentity, identities, '纳税人类型'),
    taxStatus: officialTax?.taxStatus || text(data.taxStatus, '税务状态', 60),
    taxAuthority: officialTax?.taxAuthority || text(data.taxAuthority, '主管税务机关'),
    business: [...new Set(selected as Business[])],
    bankStatus,
    accounts: bankStatus === 'none' ? [] : parseAccounts(data.accounts,
      previous && (!TAX_ID.test(previous.taxId) || previous.taxId === taxId) ? previous.accounts : []),
    ...(officialTax ? { officialTax } : {}),
  }
}

function parseAccounting(input: unknown): Accounting {
  const data = object(input)
  const history = select(data.history, ['previous', 'unrecorded', 'new'], '以前的账务情况')
  return {
    history,
    lastMonth: history === 'previous' ? text(data.lastMonth, '旧账做到的月份', 7) : '',
    startMonth: text(data.startMonth, '开始记账的月份', 7),
  }
}

function parsePayroll(input: unknown): Payroll {
  const data = object(input)
  const payroll = select(data.payroll, ['scheduled', 'none'], '发薪安排')
  if (payroll === 'scheduled' && data.payday !== undefined && data.payday !== '' && typeof data.payday !== 'number')
    throw new InputError('请选择每月发薪日。')
  return {
    payroll,
    ...(payroll === 'scheduled' && typeof data.payday === 'number' ? { payday: data.payday } : {}),
    social: select(data.social, ['all', 'partial', 'none', 'unknown'], '社保情况'),
  }
}

function validateEnterprise(data: Enterprise | undefined, today: string): Refusal | undefined {
  if (!data?.companyName || !TAX_ID.test(data.taxId)) return refuse('ENTERPRISE_REQUIRED', '请填写企业全称和 18 位统一社会信用代码。')
  if (!isCalendarDate(data.establishedOn) || data.establishedOn > today)
    return refuse('ESTABLISHED_DATE_INVALID', '请按营业执照填写有效的成立日期。')
  if (data.province || data.city) {
    if (!Object.hasOwn(cities, data.province) || !cities[data.province]?.includes(data.city))
      return refuse('REGION_INVALID', '请重新选择省份和城市或地区。')
  }
  const reason = [
    ...(data.taxpayerIdentity === 'general' ? ['增值税一般纳税人'] : []),
    ...(isBlockedStatus(data.taxStatus) ? [`税务状态为${data.taxStatus}`] : []),
    ...data.business.filter(value => value !== 'none').map(value => businessLabels[value]),
  ]
  if (reason.length) return refuse('ENTERPRISE_UNSUPPORTED', `当前版本暂不能承接${reason.join('、')}的企业。请核对这一步的资料。`, { step: 1 })
  if (!data.taxpayerIdentity) return refuse('TAX_IDENTITY_REQUIRED', '请确认纳税人类型，暂未查到可选待核实。')
  if (!data.business.includes('none')) return refuse('BUSINESS_REQUIRED', '请确认企业目前实际开展的业务。')
  if (!data.bankStatus) return refuse('BANK_STATUS_REQUIRED', '请确认银行账户情况，资料未齐可以选待补。')
  if (data.bankStatus === 'provided' && (!data.accounts.length || data.accounts.some(account => !account.holder || !account.number || !account.bank || !account.currency)))
    return refuse('BANK_ACCOUNT_REQUIRED', '请补齐账户户名、账号、开户行和币种，资料未齐可以选待补。')
  const numbers = data.accounts.map(account => account.number).filter(Boolean)
  if (numbers.some(number => !/^\d{4,34}$/.test(number)) || numbers.length !== new Set(numbers).size)
    return refuse('BANK_NUMBER_INVALID', '请检查银行账号格式，并去掉重复的账户。')
  if (data.accounts.some(account => account.currency && !/^[A-Z]{3}$/.test(account.currency)))
    return refuse('BANK_CURRENCY_INVALID', '请选择账户币种。')
  if (data.accounts.some(account => account.openedOn && (!isCalendarDate(account.openedOn) || account.openedOn > today)))
    return refuse('BANK_DATE_INVALID', '请核对账户开户日期。')
}

function validateAccounting(data: Accounting | undefined, enterprise: Enterprise | undefined, today: string): Refusal | undefined {
  if (!data?.history || !PERIOD_KEY.test(data.startMonth))
    return refuse('ACCOUNTING_REQUIRED', '请选择以前的账务情况和开始记账的月份。')
  const firstMonth = enterprise?.establishedOn.slice(0, 7) ?? ''
  if (data.startMonth < firstMonth)
    return refuse('START_MONTH_BEFORE_ESTABLISHED', '开始记账的月份不能早于企业成立月份。')
  const currentMonth = today.slice(0, 7)
  const nextMonth = currentMonth.endsWith('-12') ? `${Number(currentMonth.slice(0, 4)) + 1}-01`
    : `${currentMonth.slice(0, 4)}-${String(Number(currentMonth.slice(5)) + 1).padStart(2, '0')}`
  if (data.startMonth > nextMonth)
    return refuse('START_MONTH_TOO_LATE', '开始记账的月份最晚可选下个月。')
  if (data.history === 'previous' && (!PERIOD_KEY.test(data.lastMonth) || data.lastMonth < firstMonth || data.lastMonth > currentMonth))
    return refuse('LAST_MONTH_INVALID', '请核对旧账做到的月份，应在企业成立到当前月份之间。')
  if (data.history === 'previous' && data.startMonth <= data.lastMonth)
    return refuse('BOOK_PERIOD_OVERLAP', `旧账已做到 ${data.lastMonth}。请选择之后的起账月份，或先更正旧账截止月。`, { step: 2 })
}

function validatePayroll(data: Payroll | undefined): Refusal | undefined {
  if (!data?.payroll || !data.social) return refuse('PAYROLL_REQUIRED', '请分别确认工资和社保安排。')
  if (data.payroll === 'scheduled' && (data.payday === undefined || !Number.isInteger(data.payday) || data.payday < 1 || data.payday > 31))
    return refuse('PAYDAY_INVALID', '请选择每月发薪的日期。')
}

function handoffAction(store: BookStore, accounting: Accounting): NextAction {
  if (store.openingBalancesSetAt()) return 'bookkeeping'
  if (accounting.history === 'previous' && previousPeriod(accounting.startMonth) !== accounting.lastMonth)
    return 'review-book-periods'
  return 'opening-balances'
}

/** Preserve the four-step review when a legacy open-book call targets a company with an active draft. */
export function checkOnboardingBookOpen(store: BookStore, companyName: string, taxId?: string): Refusal | undefined {
  const draft = store.companyOnboarding()
  if (!draft || draft.revision === 0 || draft.completedAt || !draft.enterprise) return
  const name = normalizeCompanyName(draft.enterprise.companyName)
  const sameName = !!name && name === normalizeCompanyName(companyName)
  const code = draft.enterprise.taxId
  const sameCode = TAX_ID.test(code) && code === taxId?.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
  if (sameName || sameCode) {
    return refuse('ONBOARDING_IN_PROGRESS', '这家企业已有建档草稿。请用对话头部的「开始建档」继续核对，再确认建档。', { step: draft.step })
  }
}

/** Status used for natural-language guidance. Account details and uploaded documents stay behind the onboarding UI. */
export function onboardingBookStatus(store: BookStore) {
  const record = store.companyOnboarding()
  if (!record || record.revision === 0) return undefined
  if (!record.completedAt || !record.accounting) return {
    completed: false as const,
    step: record.step,
    guidance: '企业建档资料已保存。请用对话头部的「开始建档」继续当前步骤。',
  }
  const { accounting, enterprise, payroll } = record
  const nextAction = handoffAction(store, accounting)
  const guidance = nextAction === 'bookkeeping' ? '建档和期初余额均已确认，可以继续记账。'
    : nextAction === 'review-book-periods'
      ? '旧账月份和起账月份之间有空档。先核对交接范围，再请原财务提供相关期间的科目余额表，确认期初余额后再记账。'
      : accounting.history === 'previous'
        ? '请原财务提供起账月前一期的科目余额表，核对并录入期初余额后再记账。'
        : '请先确认起账月初的科目余额。如果期初确实没有余额，请明确确认期初为零。'
  return {
    completed: true as const, ...accounting, payroll, nextAction, guidance,
    bankStatus: enterprise?.bankStatus,
    confirmedAccountLabels: enterprise?.bankStatus === 'provided'
      ? enterprise.accounts.map(account => `${account.bank} 尾号 ${account.number.slice(-4)}`)
      : [],
  }
}

export class CompanyOnboarding {
  constructor(private readonly store: BookStore, private readonly now: () => Date = () => new Date()) {}

  private record(): OnboardingRecord {
    const saved = this.store.companyOnboarding()
    if (saved) return saved
    const record: OnboardingRecord = { draftId: randomUUID(), revision: 0, step: 1 }
    const company = this.store.company()
    if (company && !company.isSample) {
      const taxId = company.taxId?.toUpperCase()
      record.enterprise = parseEnterprise({
        companyName: company.name.length <= 200 && !/\p{Cc}|\p{Cf}/u.test(company.name) ? company.name : '',
        taxId: taxId && TAX_ID.test(taxId) ? taxId : '',
      })
    }
    this.store.saveCompanyOnboarding(record)
    return record
  }

  private view(record: OnboardingRecord): OnboardingView {
    const { enterprise, ...state } = record
    const view: OnboardingView = {
      accepted: true, ...state, completed: !!record.completedAt,
      replacesSampleBook: this.store.company()?.isSample === true,
      ...(enterprise ? {
        enterprise: {
          ...enterprise,
          accounts: enterprise.accounts.map(({ number, ...account }) => ({
            ...account, ...(number ? { maskedNumber: `尾号 ${number.slice(-4)}` } : {}),
          })),
        },
      } : {}),
    }
    if (view.completed && record.accounting) view.nextAction = handoffAction(this.store, record.accounting)
    if (!view.completed && view.step === 4 && record.accounting?.history === 'previous'
        && previousPeriod(record.accounting.startMonth) !== record.accounting.lastMonth) {
      view.handoffWarning = '旧账截止月与起账月之间有空档。请核对这段月份如何处理。'
    }
    return view
  }

  status(): OnboardingView {
    return this.store.transaction(() => this.view(this.record()))
  }

  setMode(revision: number, mode: OnboardingMode): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后继续。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (mode !== 'scan' && mode !== 'manual') return refuse('DRAFT_INPUT_INVALID', '请选择扫码建档或手动填写。')
      if (record.mode !== mode) {
        record.mode = mode
        record.revision++
        this.store.saveCompanyOnboarding(record)
      }
      return this.view(record)
    })
  }

  save(step: EditableStep, revision: number, input: unknown, advance = true): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后继续。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (![1, 2, 3].includes(step) || step > record.step) return refuse('STEP_UNAVAILABLE', '请先完成前面的步骤。')
      const today = todayInChina(this.now())
      let error: Refusal | undefined
      try {
        if (step === 1) {
          const previous = record.enterprise
          record.enterprise = parseEnterprise(input, previous)
          error = validateEnterprise(record.enterprise, today)
          if (previous && ((previous.taxId && previous.taxId !== record.enterprise.taxId)
              || (previous.companyName && previous.companyName !== record.enterprise.companyName))) {
            delete record.accounting
            delete record.payroll
            record.step = 1
          }
        } else if (step === 2) {
          record.accounting = parseAccounting(input)
          error = validateAccounting(record.accounting, record.enterprise, today)
        } else {
          record.payroll = parsePayroll(input)
          error = validatePayroll(record.payroll)
        }
      } catch (error) {
        if (error instanceof InputError) return refuse('DRAFT_INPUT_INVALID', error.message)
        throw error
      }
      if (error && advance) return error
      if (error) {
        record.step = step
      } else if (step === 1 && record.step > 2 && validateAccounting(record.accounting, record.enterprise, today)) {
        record.step = 2
      } else if (advance && step === record.step) {
        record.step = (step + 1) as Step
      }
      record.revision++
      this.store.saveCompanyOnboarding(record)
      return this.view(record)
    })
  }

  applyTaxProfile(draftId: string, province: string, city: string, profile: TaxProfile): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding()
      const enterprise = record?.enterprise
      if (!record || record.completedAt || record.mode === 'manual' || record.draftId !== draftId || !enterprise
        || enterprise.province !== province || enterprise.city !== city
        || enterprise.taxId !== profile.taxId || normalizeCompanyName(enterprise.companyName) !== normalizeCompanyName(profile.companyName))
        return refuse('TAX_DRAFT_CHANGED', '企业或地区已变化，请核对当前资料后重新读取。')
      const qualification = profile.taxpayerQualification ?? ''
      const taxpayerIdentity = qualification.includes('一般纳税人') ? 'general'
        : qualification.includes('小规模纳税人') ? 'small-scale' : 'unknown'
      const statuses = [profile.taxpayerStatus, profile.registrationStatus]
        .filter((status): status is string => !!status && !['待核实', '尚未读取', '未知'].includes(status))
      const taxStatus = statuses.find(isBlockedStatus) ?? statuses[0] ?? ''
      enterprise.officialTax = {
        province, city,
        taxpayerIdentity, taxStatus, taxAuthority: profile.authority,
        obligations: profile.obligations, obligationCoverage: profile.obligationCoverage,
        observedAt: profile.observedAt, sourceUrl: profile.sourceUrl,
      }
      if (taxpayerIdentity !== 'unknown') enterprise.taxpayerIdentity = taxpayerIdentity
      if (taxStatus) enterprise.taxStatus = taxStatus
      enterprise.taxAuthority = profile.authority
      const today = todayInChina(this.now())
      if (validateEnterprise(enterprise, today)) record.step = 1
      record.revision++
      this.store.saveCompanyOnboarding(record)
      return this.view(record)
    })
  }

  confirm(revision: number, replaceSampleBook: boolean): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (record.completedAt && (revision === record.revision || revision === record.revision - 1)) return this.view(record)
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后核对。')
      if (record.step !== 4) return refuse('STEP_UNAVAILABLE', '请先填写并核对所有步骤。')
      const now = this.now()
      const today = todayInChina(now)
      const { enterprise, accounting, payroll } = record
      const error = validateEnterprise(enterprise, today) ?? validateAccounting(accounting, enterprise, today) ?? validatePayroll(payroll)
      if (error) return error
      if (!enterprise || !accounting || enterprise.taxpayerIdentity !== 'small-scale')
        return refuse('TAX_IDENTITY_UNCONFIRMED', '资料已保存。请先核实纳税人类型，再完成建档并接账。', { step: 1 })
      const company = this.store.company()
      if (company && !company.isSample) {
        const exactMatch = company.taxId?.toUpperCase() === enterprise.taxId
          && normalizeCompanyName(company.name) === normalizeCompanyName(enterprise.companyName)
          && company.accountingStartMonth === accounting.startMonth
        if (!exactMatch) return refuse('BOOK_EXISTS', '本机已有正式账本。请核对企业、信用代码和起账月份，原账本已保留。')
      } else {
        const result = openBook(this.store, {
          companyName: enterprise.companyName,
          taxId: enterprise.taxId,
          accountingStartMonth: accounting.startMonth,
          replaceSampleBook,
        })
        if (!result.accepted) return result
      }
      record.completedAt = now.toISOString()
      record.revision++
      this.store.saveCompanyOnboarding(record)
      return this.view(record)
    })
  }
}
