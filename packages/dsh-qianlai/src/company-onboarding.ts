import { randomUUID } from 'node:crypto'

import { openBook } from './book.js'
import { accountingSystemChoices, availableFields, fieldPatch, incomeMethodChoices, missingTaxFields, onboardingFields, taxFields, taxStatusChoices, type FormField } from './onboarding-fields.js'
import { isCalendarDate, PERIOD_KEY, previousPeriod, refuse, todayInChina, type Refusal } from './period.js'
import type { BookStore } from './store.js'
import regions from './tax-regions.json' with { type: 'json' }
import type { TaxProfile } from './tax-portal.js'
import { taxPortalFor } from './tax-portals.js'

type Step = 1 | 2 | 3 | 4
type EditableStep = Exclude<Step, 4>
export type OnboardingMode = 'scan' | 'manual'
type DocumentKind = 'license' | 'tax'
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
  incomeMethod?: string
  accountingSystem?: string
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
  taxStatusOther?: string
  incomeMethod?: string
  accountingSystem?: string
  accountingSystemOther?: string
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
  taxFlowId?: string
  correction?: CorrectionField
  cards?: StoredCard[]
  enterprise?: Enterprise
  accounting?: Accounting
  payroll?: Payroll
  completedAt?: string
}

type NextAction = 'review-book-periods' | 'opening-balances' | 'bookkeeping'

export interface OnboardingView extends Omit<OnboardingRecord, 'enterprise' | 'cards' | 'taxFlowId' | 'correction'> {
  accepted: true
  completed: boolean
  replacesSampleBook: boolean
  enterprise?: Omit<Enterprise, 'accounts'> & { accounts: (Omit<Account, 'number'> & { maskedNumber?: string })[] }
  nextAction?: NextAction
  handoffWarning?: string
}

interface CardBase {
  id: string
  draftId: string
  revision: number
}

interface DocumentCard {
  kind: 'document'
  documentKind: DocumentKind
  fields: FormField[]
  initialValues?: Record<string, unknown>
}

type CardContent = (
  | { kind: 'mode' | 'region' | 'bank' | 'bank-next' }
  | { kind: 'source' | 'upload'; documentKind: 'license' | 'tax' }
  | DocumentCard
  | { kind: 'fields'; fields: FormField[]; step?: EditableStep; initialValues?: Record<string, unknown>; correction?: true }
  | { kind: 'tax-scan'; province: string; city: string; autoStart?: true }
  | { kind: 'confirm'; replacesSampleBook: boolean }
  | { kind: 'blocked'; message: string }
) & { title?: string; message?: string }
type OnboardingCard = CardBase & CardContent
interface CardReceipt { labels: string[]; mode?: OnboardingMode; choice?: string; notice?: string }
interface StoredCard { sessionId: string; card: OnboardingCard; receipt?: CardReceipt; autoStartClaimed?: true }
export type OnboardingGuideAction = 'start' | 'continue' | 'fill' | 'review-document' | 'switch-mode' | 'correct'

const companyDocumentKeys = ['companyName', 'taxId', 'establishedOn']

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
const editableSections = {
  company: { step: 1, keys: ['companyName', 'taxId', 'establishedOn', 'business'] },
  tax: { step: 1, keys: taxFields.map(field => field.key) },
  bank: { step: 1, keys: ['bankStatus', 'accounts'] },
  accounting: { step: 2, keys: ['history', 'lastMonth', 'startMonth'] },
  payroll: { step: 3, keys: ['payroll', 'payday', 'social'] },
} satisfies Record<string, { step: EditableStep; keys: string[] }>

const correctionSections = {
  companyName: 'company', establishedOn: 'company', business: 'company',
  taxAuthority: 'tax', taxStatus: 'tax', taxpayerIdentity: 'tax', incomeMethod: 'tax', accountingSystem: 'tax',
  lastMonth: 'accounting', startMonth: 'accounting',
} as const satisfies Record<string, keyof typeof editableSections>
type CorrectionField = keyof typeof correctionSections

function isCorrectionField(field: unknown): field is CorrectionField {
  return typeof field === 'string' && Object.hasOwn(correctionSections, field)
}

function correctionPending() {
  return refuse('DRAFT_CORRECTION_PENDING', '请先在当前更正表单里核对并保存，再继续建档。')
}

function isOfficialField(key: string, profile?: OfficialTax) {
  return !!profile && (['companyName', 'taxId', 'province', 'city', 'taxAuthority'].includes(key) ||
    (key === 'taxStatus' && !!profile.taxStatus) ||
    (key === 'incomeMethod' && !!profile.incomeMethod) ||
    (key === 'accountingSystem' && !!profile.accountingSystem) ||
    (key === 'taxpayerIdentity' && profile.taxpayerIdentity !== 'unknown'))
}

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
  const business = [...new Set(selected as Business[])]
  if (business.includes('none') && business.length > 1)
    throw new InputError('请在「以上都没有」和实际经营项目之间选择。')
  const bankStatus = select(data.bankStatus, ['provided', 'none', 'pending'], '账户情况')
  const taxStatus = officialTax?.taxStatus || select(data.taxStatus, Object.keys(taxStatusChoices), '纳税人状态')
  const accountSystem = officialTax?.accountingSystem || select(data.accountingSystem, Object.keys(accountingSystemChoices), '会计制度')
  return {
    companyName, taxId, province, city,
    establishedOn: text(data.establishedOn, '成立日期', 10),
    taxpayerIdentity: officialTax && officialTax.taxpayerIdentity !== 'unknown'
      ? officialTax.taxpayerIdentity : select(data.taxpayerIdentity, identities, '纳税人身份'),
    taxStatus: taxStatus && !Object.hasOwn(taxStatusChoices, taxStatus) ? '其他' : taxStatus,
    taxStatusOther: taxStatus === '其他' ? text(data.taxStatusOther, '具体纳税人状态', 160)
      : !Object.hasOwn(taxStatusChoices, taxStatus) ? taxStatus : '',
    taxAuthority: officialTax?.taxAuthority || text(data.taxAuthority, '主管税务机关'),
    incomeMethod: officialTax?.incomeMethod || select(data.incomeMethod, Object.keys(incomeMethodChoices), '企业所得税征收方式'),
    accountingSystem: accountSystem,
    accountingSystemOther: accountSystem === '其他' ? text(data.accountingSystemOther, '具体会计制度', 160) : '',
    business,
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
    ...(isBlockedStatus(data.taxStatus) ? [`纳税人状态为${data.taxStatus}`] : []),
    ...data.business.filter(value => value !== 'none').map(value => businessLabels[value]),
  ]
  if (reason.length) return refuse('ENTERPRISE_UNSUPPORTED', `当前版本暂不能承接${reason.join('、')}的企业。请核对这一步的资料。`, { step: 1 })
  const missingTax = missingTaxFields({ ...data })
  if (missingTax.length) return refuse('TAX_DETAILS_REQUIRED', '请补齐' + missingTax.map(field => field.label).join('、') + '。', { step: 1 })
  if (!data.business.includes('none')) return refuse('BUSINESS_REQUIRED', '请确认企业目前实际开展的业务。')
  if (!data.bankStatus) return refuse('BANK_STATUS_REQUIRED', '请确认银行账户情况，资料未齐可以选待补。')
  if (data.bankStatus === 'provided' && (!data.accounts.length || data.accounts.some(account => !account.holder || !account.number || !account.bank || !account.currency)))
    return refuse('BANK_ACCOUNT_REQUIRED', '请补齐账户户名、账号、开户行和币种，资料未齐可以选待补。')
  return validateAccountValues(data.accounts, today)
}

function validateAccountValues(accounts: readonly Account[], today: string): Refusal | undefined {
  const numbers = accounts.map(account => account.number).filter(Boolean)
  if (numbers.some(number => !/^\d{4,34}$/.test(number)) || numbers.length !== new Set(numbers).size)
    return refuse('BANK_NUMBER_INVALID', '请检查银行账号格式，并去掉重复的账户。')
  if (accounts.some(account => account.currency && !/^[A-Z]{3}$/.test(account.currency)))
    return refuse('BANK_CURRENCY_INVALID', '请选择账户币种。')
  if (accounts.some(account => account.openedOn && (!isCalendarDate(account.openedOn) || account.openedOn > today)))
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
    return refuse('ONBOARDING_IN_PROGRESS', '这家企业已有建档草稿。请在对话里说「继续建档」，核对资料后再确认。', { step: draft.step })
  }
}

/** Status used for natural-language guidance. Account details and uploaded documents stay behind the onboarding UI. */
export function onboardingBookStatus(store: BookStore) {
  const record = store.companyOnboarding()
  if (!record || record.revision === 0) return undefined
  if (!record.completedAt || !record.accounting) return {
    completed: false as const,
    step: record.step,
    guidance: '企业建档资料已保存。在对话里说「继续建档」即可回到当前步骤。',
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
    if (saved) {
      // Old drafts could contain contradictory choices. Preserve every reported business activity for review.
      const enterprise = saved.enterprise
      if (enterprise?.business.includes('none') && enterprise.business.some(value => value !== 'none')) {
        enterprise.business = enterprise.business.filter(value => value !== 'none')
      }
      if (enterprise && !Object.hasOwn(enterprise, 'incomeMethod')) {
        if (enterprise.taxStatus && !Object.hasOwn(taxStatusChoices, enterprise.taxStatus)) {
          enterprise.taxStatusOther = enterprise.taxStatus
          enterprise.taxStatus = '其他'
        }
        enterprise.incomeMethod = ''
        enterprise.accountingSystem ??= ''
        if (!saved.completedAt && (saved.mode !== 'scan' || enterprise.officialTax || saved.step > 1)) {
          saved.step = 1
          saved.revision++
        }
        this.store.saveCompanyOnboarding(saved)
      }
      return saved
    }
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
    const { enterprise, draftId, revision, step, mode, accounting, payroll, completedAt } = record
    const view: OnboardingView = {
      accepted: true, draftId, revision, step, completed: !!completedAt,
      ...(mode ? { mode } : {}),
      ...(accounting ? { accounting } : {}),
      ...(payroll ? { payroll } : {}),
      ...(completedAt ? { completedAt } : {}),
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

  private stepValues(record: OnboardingRecord, step = record.step): Record<string, unknown> {
    return { ...({ 1: record.enterprise, 2: record.accounting, 3: record.payroll, 4: undefined }[step]) }
  }

  editSection(revision: number, section: unknown, input: unknown): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请核对当前版本后重试。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (typeof section !== 'string' || !Object.hasOwn(editableSections, section))
        return refuse('DRAFT_INPUT_INVALID', '请选择需要修改的资料。')
      const { step, keys } = editableSections[section as keyof typeof editableSections]
      const current = this.stepValues(record, step)
      const today = todayInChina(this.now())
      const patch: Record<string, unknown> = {}
      try {
        for (const [key, value] of Object.entries(object(input))) {
          if (!keys.includes(key)) throw new InputError('请按当前分组修改资料。')
          if (current[key] === value) continue
          if (isOfficialField(key, record.enterprise?.officialTax))
            throw new InputError('这是从税务机关读取的资料。如需更正，请核对税务资料。')
          if (key === 'accounts') {
            if (!Array.isArray(value) || value.some(account => Object.keys(object(account))
              .some(field => !['id', 'holder', 'number', 'bank', 'currency', 'openedOn'].includes(field))))
              throw new InputError('请核对银行账户资料。')
            const accounts = parseAccounts(value, record.enterprise?.accounts ?? [])
            if (accounts.some(account => !account.holder || !account.number || !account.bank || !account.currency))
              throw new InputError('请补齐账户户名、账号、开户行和币种。')
            const invalid = validateAccountValues(accounts, today)
            if (invalid) return invalid
            // The original input preserves which IDs were supplied by the caller.
            patch[key] = value
          } else if (value === '' || (key === 'business' && Array.isArray(value) && !value.length)) {
            patch[key] = value
          } else {
            Object.assign(patch, fieldPatch(onboardingFields[step], {
              [key]: key === 'payday' && typeof value === 'number' ? String(value) : value,
            }, today))
          }
        }
      } catch (error) {
        return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
      }
      if (!Object.keys(patch).length) return this.view(record)
      const previous = record.enterprise
      const changesCompany = previous?.taxId && typeof patch.taxId === 'string' &&
        previous.taxId !== patch.taxId.toUpperCase()
      if (changesCompany && previous.accounts.length)
        return refuse('COMPANY_ACCOUNT_MISMATCH', '请先核对并移除已有银行账户，再更正信用代码。')
      const tax = changesCompany ? { province: '', city: '', ...Object.fromEntries(taxFields.map(field => [field.key, ''])) } : {}
      const saved = this.save(step, revision, { ...current, ...tax, ...patch }, false, true)
      if (saved.accepted && record.correction && patch[record.correction]) {
        const updated = this.record()
        delete updated.correction
        this.store.saveCompanyOnboarding(updated)
      }
      return saved
    })
  }

  /** Save only missing fields. Existing data, including account details, stays in the draft. */
  private saveFields(record: OnboardingRecord, fields: readonly FormField[], values: unknown, step = record.step): OnboardingView | Refusal {
    if (step === 4) return refuse('STEP_UNAVAILABLE', '请通过对话里的确认卡继续。')
    let patch: Record<string, unknown>
    try {
      patch = fieldPatch(fields, object(values), todayInChina(this.now()))
      if (!Object.keys(patch).length) throw Error('请先填写一项资料。')
    } catch (error) {
      return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
    }
    return this.save(step, record.revision, { ...this.stepValues(record, step), ...patch }, false)
  }

  private editCard(record: OnboardingRecord, step: EditableStep): CardContent {
    const current = this.stepValues(record, step)
    const fields = onboardingFields[step].filter(({ key }) =>
      !isOfficialField(key, record.enterprise?.officialTax) &&
      (key !== 'lastMonth' || current.history === 'previous') &&
      (key !== 'payday' || current.payroll === 'scheduled'))
    const initialValues = Object.fromEntries(fields.filter(field => current[field.key] !== undefined)
      .map(field => [field.key, field.key === 'payday' ? String(current[field.key]) : current[field.key]]))
    return { kind: 'fields', title: { 1: '更正企业资料', 2: '更正记账准备', 3: '更正工资社保' }[step], step, fields, initialValues }
  }

  private correctionCard(record: OnboardingRecord, key: CorrectionField) {
    const { step } = editableSections[correctionSections[key]]
    const field = onboardingFields[step].find(field => field.key === key)!
    const fields = [field, ...taxFields.filter(item => item.requiredWhen === key)]
    const current = this.stepValues(record, step)
    return {
      kind: 'fields' as const, step, correction: true as const,
      title: '更正' + field.label, fields,
      initialValues: Object.fromEntries(fields.map(item => [item.key, current[item.key] ?? (item.type === 'multi' ? [] : '')])),
    }
  }

  private prepareCorrection(record: OnboardingRecord, key: unknown, values: Record<string, unknown>) {
    if (!record.mode || !isCorrectionField(key)) return refuse('DRAFT_INPUT_INVALID', '请选择一项要更正的建档资料。')
    if (isOfficialField(key, record.enterprise?.officialTax))
      return refuse('DRAFT_INPUT_INVALID', '这是从税务机关读取的资料。如需更正，请核对税务资料。')
    if (key === 'lastMonth' && record.accounting?.history !== 'previous')
      return refuse('DRAFT_INPUT_INVALID', '请先确认有旧账，再核对旧账做到的月份。')
    const card = this.correctionCard(record, key)
    try {
      Object.assign(card.initialValues, fieldPatch(card.fields, values, todayInChina(this.now())))
    } catch (error) {
      return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
    }
    if (record.correction !== key) {
      record.correction = key
      record.revision++
      this.store.saveCompanyOnboarding(record)
    }
    return { accepted: true as const, card }
  }

  private documentCard(record: OnboardingRecord): DocumentCard | undefined {
    if (record.step !== 1 || !record.mode || (record.mode === 'scan' && !record.enterprise?.officialTax)) return
    const { companyName, taxId = '', establishedOn = '' } = record.enterprise ?? {}
    const missingCompany = {
      companyName: !companyName,
      taxId: !TAX_ID.test(taxId),
      establishedOn: !isCalendarDate(establishedOn) || establishedOn > todayInChina(this.now()),
    }
    const company = onboardingFields[1].filter(field =>
      companyDocumentKeys.includes(field.key) && missingCompany[field.key as keyof typeof missingCompany])
    if (company.length) return { kind: 'document', documentKind: 'license', fields: company }
    const current = this.stepValues(record)
    const missing = new Set(missingTaxFields(current).map(field => field.key))
    if (!missing.size) return
    for (const field of taxFields) {
      if (missing.has(field.key) && field.requiredWhen && !isOfficialField(field.requiredWhen, record.enterprise?.officialTax))
        missing.add(field.requiredWhen)
    }
    const fields = taxFields.filter(field => missing.has(field.key) || (field.requiredWhen && missing.has(field.requiredWhen)))
    const initialValues = Object.fromEntries(taxFields.filter(field => (missing.has(field.key) ||
      fields.some(item => item.requiredWhen === field.key)) && current[field.key]).map(field => [field.key, current[field.key]]))
    return { kind: 'document', documentKind: 'tax', fields, ...(Object.keys(initialValues).length ? { initialValues } : {}) }
  }

  private documentPreview(record: OnboardingRecord, card: DocumentCard, values: Record<string, unknown>) {
    const { enterprise } = record
    const { companyName, taxId } = values
    const normalizedTaxId = typeof taxId === 'string' ? taxId.trim().toUpperCase() : ''
    if ((typeof companyName === 'string' && enterprise?.companyName &&
        normalizeCompanyName(companyName) !== normalizeCompanyName(enterprise.companyName)) ||
        (TAX_ID.test(normalizedTaxId) && enterprise?.taxId && normalizedTaxId !== enterprise.taxId))
      return refuse('DOCUMENT_SUBJECT_MISMATCH', '资料中的企业名称或信用代码与建档草稿不一致。请核对企业后再继续。')

    const fields: Record<string, unknown> = {}
    const today = todayInChina(this.now())
    for (const field of card.fields) {
      if (!Object.hasOwn(values, field.key)) continue
      try {
        Object.assign(fields, fieldPatch([field], { [field.key]: values[field.key] }, today))
      } catch {
        // An unreadable field stays empty so the user can fill it in.
      }
    }
    if (!Object.keys(fields).length)
      return refuse('DOCUMENT_EMPTY', '没有读到可核对的缺项。可以换一份清晰资料，或直接在卡片上填写。')
    return { accepted: true as const, fields }
  }

  private nextCard(record: OnboardingRecord): CardContent | undefined {
    if (record.completedAt) return undefined
    if (record.correction) return this.correctionCard(record, record.correction)
    if (!record.mode) return { kind: 'mode' }
    const today = todayInChina(this.now())
    const enterprise = record.enterprise
    if (record.mode === 'scan' && !enterprise?.officialTax) {
      if (!enterprise?.province || !enterprise.city) return { kind: 'region' }
      if (!taxPortalFor(enterprise.province, enterprise.city))
        return { kind: 'region', message: '该辖区暂未接入扫码取数。您可以核对地区，或在聊天里告诉我改为手动填写。' }
      return { kind: 'tax-scan', province: enterprise.province, city: enterprise.city }
    }
    if (record.step === 1) {
      const document = this.documentCard(record)
      if (document) return document
      const fields = availableFields(1, this.stepValues(record))
      const error = validateEnterprise(enterprise, today)
      if (error?.code === 'ENTERPRISE_UNSUPPORTED') return { kind: 'blocked', message: error.message }
      if (fields.some(field => field.key === 'business')) return { kind: 'fields', title: '确认实际经营', fields: fields.filter(field => field.key === 'business') }
      if (fields.some(field => field.key === 'bankStatus')) return { kind: 'fields', title: '确认账户情况', fields: fields.filter(field => field.key === 'bankStatus') }
      if (enterprise?.bankStatus === 'provided' && !enterprise.accounts.length) return { kind: 'bank' }
      if (error) return { kind: 'blocked', message: error.message }
    } else if (record.step === 2 || record.step === 3) {
      const current = this.stepValues(record)
      const error = record.step === 2 ? validateAccounting(record.accounting, record.enterprise, today) : validatePayroll(record.payroll)
      if (error) {
        const missing = availableFields(record.step, current)
        const applicable = onboardingFields[record.step].filter(({ key }) =>
          (key !== 'lastMonth' || current.history === 'previous') && (key !== 'payday' || current.payroll === 'scheduled'))
        const fieldSet = record.step === 2 && !current.history ? applicable.filter(({ key }) => key === 'history')
          : missing.length ? missing : applicable
        const initialValues = Object.fromEntries(fieldSet.filter(({ key }) => current[key] !== undefined)
          .map(({ key }) => [key, key === 'payday' ? String(current[key]) : current[key]]))
        const expected = ['ACCOUNTING_REQUIRED', 'PAYROLL_REQUIRED'].includes(error.code)
        return { kind: 'fields', title: record.step === 2 ? '确认记账准备' : '确认工资社保', fields: fieldSet,
          ...(Object.keys(initialValues).length ? { initialValues } : {}), ...(!expected ? { message: error.message } : {}) }
      }
    } else {
      if (enterprise?.taxpayerIdentity !== 'small-scale') return {
        kind: 'fields', title: '确认纳税人类型', step: 1, message: '建档前请核实企业的纳税人类型。',
        fields: onboardingFields[1].filter(field => field.key === 'taxpayerIdentity'),
      }
      return { kind: 'confirm', replacesSampleBook: this.store.company()?.isSample === true }
    }
    // Complete stages advance once the existing domain validations pass.
    if (record.step < 4) {
      const saved = this.save(record.step as EditableStep, record.revision, this.stepValues(record))
      if (!saved.accepted) return { kind: 'blocked', message: saved.message }
      return this.nextCard(this.record())
    }
  }

  private issueCard(sessionId: string, content: CardContent) {
    const record = this.record()
    const current = this.activeCard(record, sessionId)
    if (current && JSON.stringify(this.cardContent(current.card)) === JSON.stringify(content)) return current.card
    const card: OnboardingCard = { id: randomUUID(), draftId: record.draftId, revision: record.revision, ...content }
    record.cards = [...(record.cards ?? []), { sessionId, card }]
    this.store.saveCompanyOnboarding(record)
    return card
  }

  private cardContent(card: OnboardingCard): CardContent {
    const content = { ...card } as Partial<CardBase> & CardContent
    delete content.id
    delete content.draftId
    delete content.revision
    return content
  }

  private cardResult(record: OnboardingRecord, item: StoredCard) {
    return {
      accepted: true as const, view: this.view(record), stale: false,
      ...(item.receipt ? { receipt: item.receipt } : { card: item.card }),
    }
  }

  private transition(sessionId: string, cardId: string, receipt: CardReceipt, choose: () => CardContent | undefined) {
    // Close the answered card first. The next card can have the same draft revision.
    const record = this.record()
    const stored = record.cards!.find(candidate => candidate.card.id === cardId)!
    stored.receipt = receipt
    this.store.saveCompanyOnboarding(record)
    const next = choose()
    if (next) this.issueCard(sessionId, next)
    return this.cardResult(this.record(), stored)
  }

  private activeCard(record: OnboardingRecord, sessionId: string) {
    const latest = record.cards?.filter(item => item.sessionId === sessionId && item.card.revision === record.revision).at(-1)
    return latest?.receipt ? undefined : latest
  }

  private saveTaxRegion(record: OnboardingRecord, values: unknown) {
    const { province, city } = values && typeof values === 'object' ? values as Record<string, unknown> : {}
    if (typeof province !== 'string' || typeof city !== 'string' || !Object.hasOwn(cities, province) || !cities[province]?.includes(city))
      return refuse('DRAFT_INPUT_INVALID', '请先确认省份和对应的城市或地区。')
    const saved = this.save(1, record.revision, { ...record.enterprise, province, city }, false)
    if (!saved.accepted) return saved
    const content: CardContent = taxPortalFor(province, city) ? { kind: 'tax-scan', province, city, autoStart: true }
      : { kind: 'region', message: '该辖区暂未接入扫码取数。您可以核对地区，或在聊天里告诉我改为手动填写。' }
    return { ...saved, content }
  }

  hasGuide(sessionId: string): boolean {
    const record = this.store.companyOnboarding()
    return !!record && !record.completedAt && record.cards?.some(item => item.sessionId === sessionId) === true
  }

  guide(sessionId: string, action: OnboardingGuideAction, fields?: unknown, values?: unknown, mode?: unknown, documentKind?: unknown) {
    return this.store.transaction(() => {
      let record = this.record()
      if (record.completedAt) return { accepted: true as const, completed: true }
      let content: CardContent | undefined
      const supplied = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {}
      if (action === 'correct' || (record.correction && action === 'fill')) {
        const field = action === 'correct' ? (Array.isArray(fields) && fields.length === 1 ? fields[0] : undefined) : record.correction
        const correction = this.prepareCorrection(record, field, supplied)
        if (!correction.accepted) return correction
        content = correction.card
        record = this.record()
      } else if (action === 'switch-mode') {
        if (mode !== 'scan' && mode !== 'manual') return refuse('DRAFT_INPUT_INVALID', '请指定改用扫码建档或手动填写。')
        const changed = record.mode !== mode
        const saved = this.setMode(record.revision, mode)
        if (!saved.accepted) return saved
        record = this.record()
        if (changed && mode === 'scan' && !record.correction && !record.enterprise?.officialTax) content = { kind: 'region' }
      } else if (record.correction && action === 'review-document') {
        return correctionPending()
      }
      const before = this.activeCard(record, sessionId)?.card
      if (!record.correction && (action === 'review-document' || action === 'fill')) {
        const document = this.documentCard(record)
        if (action === 'review-document' || document) {
          if (!document || (action === 'review-document' && documentKind !== document.documentKind))
            return refuse('DOCUMENT_STEP', '请先完成当前建档步骤，再核对这份资料。')
          const reviewed = this.documentPreview(record, document, supplied)
          if (!reviewed.accepted) return reviewed
          const earlier = before?.kind === 'document' && before.documentKind === document.documentKind ? before.initialValues : undefined
          content = { ...document, initialValues: { ...earlier, ...reviewed.fields } }
        } else if (before?.kind === 'tax-scan' && Object.keys(supplied).length === 2 &&
          supplied.province === before.province && supplied.city === before.city) {
          content = this.cardContent(before)
        } else if (record.mode === 'scan' && (before?.kind === 'region' || (!before && this.nextCard(record)?.kind === 'region'))) {
          const saved = this.saveTaxRegion(record, values)
          if (!saved.accepted) return saved
          record = this.record()
          content = saved.content
        } else {
          if (record.step === 4) return refuse('STEP_UNAVAILABLE', '请通过对话里的确认卡继续。')
          if (!record.mode || (record.mode === 'scan' && !record.enterprise?.officialTax))
            return refuse('DOCUMENT_STEP', '请先选择建档方式，或完成当前扫码步骤。')
          const saved = this.saveFields(record, availableFields(record.step, this.stepValues(record)), values)
          if (!saved.accepted) return saved
          record = this.record()
        }
      }
      const stored = this.activeCard(record, sessionId)?.card
      const active = stored?.kind === 'source' || stored?.kind === 'upload' ? undefined : stored
      if (!active) content ??= this.nextCard(record)
      const card = content ? this.issueCard(sessionId, content) : active
      const needsDocumentConfirmation = card?.kind === 'document' && Boolean(card.initialValues)
      const latest = this.record()
      const { enterprise, accounting, payroll } = latest
      const draftSummary = {
        ...(enterprise ? { enterprise: {
          companyName: enterprise.companyName, establishedOn: enterprise.establishedOn,
          ...(latest.mode === 'scan' ? { province: enterprise.province, city: enterprise.city } : {}),
          ...Object.fromEntries(taxFields.map(field => [field.key, enterprise[field.key as keyof Enterprise]])),
          business: enterprise.business, bankStatus: enterprise.bankStatus,
        } } : {}),
        ...(accounting ? { accounting } : {}),
        ...(payroll ? { payroll } : {}),
      }
      return { accepted: true as const, step: latest.step, ...(latest.mode ? { mode: latest.mode } : {}), draftSummary,
        ...(card ? { card } : {}), ...(needsDocumentConfirmation ? { needsDocumentConfirmation } : {}),
        ...(latest.correction ? { correctionPending: latest.correction } : {}) }
    })
  }

  claimTaxAutoStart(sessionId: string, cardId: string, revision: number) {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding()
      const item = record && this.activeCard(record, sessionId)
      if (!record || record.mode !== 'scan' || record.completedAt || revision !== record.revision ||
        item?.card.id !== cardId || item.card.kind !== 'tax-scan' || !item.card.autoStart || item.autoStartClaimed)
        return { accepted: true as const, start: false }
      item.autoStartClaimed = true
      this.store.saveCompanyOnboarding(record)
      return { accepted: true as const, start: true }
    })
  }

  isTaxScanCurrent(sessionId: string, draftId: string, cardId: string): boolean {
    const record = this.store.companyOnboarding()
    if (!record || record.draftId !== draftId || record.mode !== 'scan' || record.completedAt) return false
    const card = this.activeCard(record, sessionId)?.card
    return card?.id === cardId && card.kind === 'tax-scan'
  }

  cardStatus(sessionId: string, cardId: string) {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding() && this.record()
      const item = record?.cards?.find(item => item.sessionId === sessionId && item.card.id === cardId)
      if (!record || !item) return { accepted: true as const, stale: true }
      if (item.receipt) return this.cardResult(record, item)
      if (item.card.kind === 'tax-scan' && record.taxFlowId === cardId)
        return this.transition(sessionId, cardId, { labels: ['已回填官方税务资料'] }, () => this.nextCard(this.record()))
      if (record.completedAt || item.card.kind === 'source' || item.card.kind === 'upload' || this.activeCard(record, sessionId)?.card.id !== cardId)
        return { accepted: true as const, stale: true }
      return this.cardResult(record, item)
    })
  }

  private activeDocumentCard(record: OnboardingRecord, sessionId: string, cardId: string, revision: number) {
    const card = this.activeCard(record, sessionId)?.card
    return !record.completedAt && card?.kind === 'document' && card.id === cardId && card.revision === revision ? card : undefined
  }

  documentKindForCard(sessionId: string, cardId: string, revision: number) {
    return this.activeDocumentCard(this.record(), sessionId, cardId, revision)?.documentKind
  }

  previewDocumentCard(sessionId: string, cardId: string, revision: number, fields: Record<string, unknown>) {
    const record = this.record()
    const card = this.activeDocumentCard(record, sessionId, cardId, revision)
    return card ? this.documentPreview(record, card, fields)
      : refuse('CARD_UNAVAILABLE', '建档资料已更新，请继续建档后重新识别。')
  }

  submitCard(sessionId: string, cardId: string, revision: number, choice: unknown, values: unknown, replaceSampleBook = false) {
    return this.store.transaction(() => {
      const record = this.record()
      const item = record.cards?.find(item => item.sessionId === sessionId && item.card.id === cardId)
      if (!item) return refuse('CARD_UNAVAILABLE', '这张建档卡已失效，请在当前对话继续建档。')
      if (item.receipt) return this.cardResult(record, item)
      if (item.card.revision !== revision || record.completedAt || this.activeCard(record, sessionId)?.card.id !== cardId)
        return refuse('DRAFT_STALE', '资料已更新，请发送「继续建档」刷新当前步骤。')
      const card = item.card
      const invalid = () => refuse('DRAFT_INPUT_INVALID', '请按当前建档卡片继续。')
      const next = (receipt: CardReceipt, content?: CardContent) =>
        this.transition(sessionId, cardId, receipt, () => content ?? this.nextCard(this.record()))
      if (record.correction) {
        const key = record.correction
        if (card.kind !== 'fields' || !card.correction || card.fields[0]?.key !== key) return correctionPending()
        let patch: Record<string, unknown>
        try {
          patch = fieldPatch(card.fields, object(values), todayInChina(this.now()))
          if (!Object.hasOwn(patch, key)) throw Error('请填写要核对的资料。')
          const missing = card.fields.find(field => field.requiredWhen === key && patch[key] === '其他' && !patch[field.key])
          if (missing) throw Error('请填写' + missing.label + '。')
        } catch (error) {
          return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
        }
        const saved = this.editSection(revision, correctionSections[key], patch)
        if (!saved.accepted) return saved
        const updated = this.record()
        if (updated.correction) {
          delete updated.correction
          updated.revision++
          this.store.saveCompanyOnboarding(updated)
        }
        return next({ labels: [card.fields[0].label], notice: '已核对并保存' + card.fields[0].label + '。' })
      }
      if (card.kind === 'mode') {
        if (choice !== 'scan' && choice !== 'manual') return invalid()
        const saved = this.setMode(revision, choice)
        return saved.accepted ? next({ labels: ['建档方式'], mode: choice },
          choice === 'scan' && !record.enterprise?.officialTax ? { kind: 'region' } : undefined) : saved
      }
      if (card.kind === 'source' || card.kind === 'upload')
        return refuse('CARD_UNAVAILABLE', '这张建档卡已更新，请按最新资料继续建档。')
      if (card.kind === 'region') {
        const saved = this.saveTaxRegion(record, values)
        if (!saved.accepted) return saved
        return next({ labels: ['税务地区'], ...(saved.content.message ? { notice: saved.content.message } : {}) }, saved.content)
      }
      if (card.kind === 'fields' || card.kind === 'document') {
        const saved = this.saveFields(record, card.fields, values, card.kind === 'document' ? 1 : card.step)
        if (!saved.accepted) return saved
        if (card.kind === 'document') {
          const latest = this.record()
          const remaining = this.documentCard(latest)
          if (remaining?.documentKind === card.documentKind) {
            const stored = latest.cards!.find(candidate => candidate.card.id === cardId)!
            stored.card = {
              ...remaining, id: cardId, draftId: latest.draftId, revision: latest.revision,
              message: '已保存本次填写。还需补齐' + (remaining.documentKind === 'tax' ? missingTaxFields(this.stepValues(latest)) : remaining.fields)
                .map(field => field.label).join('、') + '。',
            }
            this.store.saveCompanyOnboarding(latest)
            return { ...this.cardResult(latest, stored), incomplete: true as const }
          }
        }
        return next({ labels: card.fields.filter(field => Object.hasOwn(values as object, field.key)).map(field => field.label) })
      }
      if (card.kind === 'bank') {
        const data = values && typeof values === 'object' ? values as Record<string, unknown> : {}
        if (choice === 'skip') {
          const saved = this.save(1, revision, { ...record.enterprise, bankStatus: 'pending' }, false)
          return saved.accepted ? next({ labels: ['银行资料待补'] }) : saved
        }
        if (!record.enterprise || !data.holder || !data.bank || typeof data.number !== 'string' ||
            !/^\d{4,34}$/.test(data.number.replace(/[ -]/g, '')) ||
            record.enterprise.accounts.some(account => account.number === (data.number as string).replace(/[ -]/g, '')))
          return invalid()
        if (data.currency && (typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)))
          return refuse('BANK_CURRENCY_INVALID', '请选择账户币种。')
        if (data.openedOn && (typeof data.openedOn !== 'string' || !isCalendarDate(data.openedOn) || data.openedOn > todayInChina(this.now())))
          return refuse('BANK_DATE_INVALID', '请核对账户开户日期。')
        const saved = this.save(1, revision, { ...record.enterprise, accounts: [
          ...record.enterprise.accounts, { holder: data.holder, number: data.number, bank: data.bank, currency: data.currency || 'CNY', openedOn: data.openedOn },
        ] }, false)
        return saved.accepted ? next({ labels: ['已保存银行账户'] }, { kind: 'bank-next' }) : saved
      }
      if (card.kind === 'bank-next' && (choice === 'add' || choice === 'continue'))
        return next({ labels: [choice === 'add' ? '继续补充账户' : '银行账户已核对'] }, choice === 'add' ? { kind: 'bank' } : undefined)
      if (card.kind === 'confirm' && choice === 'confirm') {
        const saved = this.confirm(revision, replaceSampleBook)
        return saved.accepted ? next({ labels: ['建档已完成'] }) : saved
      }
      if (card.kind === 'confirm') {
        const step = choice === 'edit-company' ? 1 : choice === 'edit-accounting' ? 2 : choice === 'edit-payroll' ? 3 : undefined
        if (step)
          return next({ labels: ['请核对要更正的资料'] }, this.editCard(record, step))
      }
      if (card.kind === 'blocked' && choice === 'edit' && record.step === 1) {
        const fields = onboardingFields[1].filter(({ key }) => ['business', 'bankStatus', 'taxpayerIdentity', 'taxStatus', 'taxStatusOther'].includes(key) &&
          !isOfficialField(key, record.enterprise?.officialTax))
        record.revision++
        this.store.saveCompanyOnboarding(record)
        return next({ labels: ['重新核对资料'] }, { kind: 'fields', title: '核对企业情况', fields })
      }
      return invalid()
    })
  }

  save(step: EditableStep, revision: number, input: unknown, advance = true, editingDraft = false): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后继续。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (advance && record.correction) return correctionPending()
      if (![1, 2, 3].includes(step) || (step > record.step && !editingDraft)) return refuse('STEP_UNAVAILABLE', '请先完成前面的步骤。')
      const today = todayInChina(this.now())
      let error: Refusal | undefined
      try {
        if (step === 1) {
          const previous = record.enterprise
          record.enterprise = parseEnterprise(input, previous)
          error = validateEnterprise(record.enterprise, today)
          const sameIdentity = editingDraft && previous && TAX_ID.test(previous.taxId) && previous.taxId === record.enterprise.taxId
          if (previous && !sameIdentity && ((previous.taxId && previous.taxId !== record.enterprise.taxId)
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
      if (error && step <= record.step) {
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

  applyTaxProfile(draftId: string, province: string, city: string, profile: TaxProfile, flowId?: string, sessionId?: string): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding()
      const enterprise = record?.enterprise
      if (!record || record.completedAt || record.mode === 'manual' || record.draftId !== draftId || !enterprise
        || (sessionId && this.activeCard(record, sessionId)?.card.id !== flowId)
        || enterprise.province !== province || enterprise.city !== city
        || !TAX_ID.test(profile.taxId) || !profile.companyName.trim()
        || (enterprise.taxId && enterprise.taxId !== profile.taxId)
        || (enterprise.companyName && normalizeCompanyName(enterprise.companyName) !== normalizeCompanyName(profile.companyName)))
        return refuse('TAX_DRAFT_CHANGED', '企业或地区已变化，请核对当前资料后重新读取。')
      enterprise.taxId ||= profile.taxId
      enterprise.companyName ||= profile.companyName
      if (!enterprise.establishedOn && profile.establishedOn && isCalendarDate(profile.establishedOn)) enterprise.establishedOn = profile.establishedOn
      if (flowId) record.taxFlowId = flowId
      const qualification = profile.taxpayerQualification ?? ''
      const taxpayerIdentity = qualification.includes('一般纳税人') ? 'general'
        : qualification.includes('小规模纳税人') ? 'small-scale' : 'unknown'
      const statuses = [profile.taxpayerStatus, profile.registrationStatus]
        .filter((status): status is string => !!status && !['待核实', '尚未读取', '未知'].includes(status))
      const taxStatus = statuses.find(isBlockedStatus) ?? statuses[0] ?? ''
      const incomeMethod = profile.incomeMethod && Object.hasOwn(incomeMethodChoices, profile.incomeMethod)
        ? profile.incomeMethod : undefined
      const accountingSystem = profile.accountingSystem && Object.hasOwn(accountingSystemChoices, profile.accountingSystem)
        ? profile.accountingSystem : undefined
      enterprise.officialTax = {
        province, city,
        taxpayerIdentity, taxStatus, taxAuthority: profile.authority,
        ...(incomeMethod ? { incomeMethod } : {}), ...(accountingSystem ? { accountingSystem } : {}),
        obligations: profile.obligations, obligationCoverage: profile.obligationCoverage,
        observedAt: profile.observedAt, sourceUrl: profile.sourceUrl,
      }
      if (taxpayerIdentity !== 'unknown') enterprise.taxpayerIdentity = taxpayerIdentity
      if (taxStatus) {
        if (Object.hasOwn(taxStatusChoices, taxStatus)) {
          enterprise.taxStatus = taxStatus
          if (taxStatus !== '其他') enterprise.taxStatusOther = ''
        } else {
          enterprise.taxStatus = '其他'
          enterprise.taxStatusOther = taxStatus
        }
      }
      if (incomeMethod) enterprise.incomeMethod = incomeMethod
      if (accountingSystem) {
        enterprise.accountingSystem = accountingSystem
        if (accountingSystem !== '其他') enterprise.accountingSystemOther = ''
      }
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
      if (record.correction) return correctionPending()
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
