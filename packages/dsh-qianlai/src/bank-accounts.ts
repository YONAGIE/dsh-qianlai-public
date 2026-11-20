import type { BookStore } from './store.js'

interface RegisteredBankAccount {
  readonly id: string
  readonly bank: string
  readonly number: string
  readonly currency: string
  readonly openedOn: string
}

const normalizeLabel = (value: string) => value.normalize('NFKC').replace(/\s+/g, '')
export const accountDigits = (label: string) => label.match(/(?:尾号|\*{2,})\s*[:：]?\s*(\d{4,34})\s*$/u)?.[1] ??
  label.replace(/\D/g, '')

export function sameBank(a: string, b: string) {
  const x = normalizeLabel(a)
  const y = normalizeLabel(b)
  return !!x && !!y && (x.includes(y) || y.includes(x))
}

export function bankFromRef(ref: string) {
  return ref.replace(/\s*(?:尾号|\*{2,})?\s*[:：]?\s*[\d-]+\s*$/u, '').trim()
}

export function registeredBankProfile(store: BookStore): {
  readonly status: 'provided' | 'none' | 'pending' | ''
  readonly accounts: readonly RegisteredBankAccount[]
} | undefined {
  const company = store.company()
  const record = store.companyOnboarding()
  const enterprise = record?.enterprise
  if (!company || company.isSample || !enterprise || !record.completedAt ||
    company.taxId !== enterprise.taxId || normalizeLabel(company.name) !== normalizeLabel(enterprise.companyName)) return undefined
  return { status: enterprise.bankStatus, accounts: enterprise.accounts }
}

export function bankRegistrationView(store: BookStore, businessDate: string) {
  const profile = registeredBankProfile(store)
  const coverage = store.statementCoverage()
  const accounts = (profile?.accounts ?? []).map(account => {
    const tail = account.number.slice(-4)
    const matching = coverage.filter(line => {
      const digits = accountDigits(line.accountRef)
      return digits.length >= 4 && sameBank(account.bank, bankFromRef(line.accountRef)) &&
        (account.number.endsWith(digits) || digits.endsWith(account.number))
    })
    return {
      id: account.id,
      accountRef: account.bank + ' 尾号 ' + tail,
      label: account.bank + ' 尾号 ' + tail,
      tail,
      currency: account.currency,
      openedOn: account.openedOn || null,
      coverageStartsOn: matching.map(line => line.from).sort()[0] ?? null,
      // A new account has no statement history before it was opened.
      reviewFrom: account.openedOn
        ? [account.openedOn, (store.company()?.accountingStartMonth ?? businessDate.slice(0, 7)) + '-01'].sort().at(-1)
        : null,
    }
  })
  return { status: profile?.status || 'pending', accounts }
}
