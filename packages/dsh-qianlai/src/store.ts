import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { parseAmountToCents, type LedgerPosting } from '@moneycome/fintax-core'

/**
 * 本机一本账。一个 SQLite 文件只放一家企业。
 *
 * 金额一律存整数分，读出时用 bigint，避免浮点误差让借贷平衡判错。
 * 表结构的版本记在 `PRAGMA user_version`，加表时在 MIGRATIONS 末尾追加一段。
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE company (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    tax_id TEXT,
    accounting_start_month TEXT NOT NULL,
    is_sample INTEGER NOT NULL
  );
  CREATE TABLE company_fact (
    fact_key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE voucher (
    id INTEGER PRIMARY KEY,
    period_key TEXT NOT NULL,
    voucher_no TEXT NOT NULL UNIQUE,
    voucher_date TEXT NOT NULL,
    summary TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    event_kind TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    pack_ref TEXT NOT NULL,
    required_roles_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE voucher_leg (
    voucher_id INTEGER NOT NULL REFERENCES voucher(id),
    seq INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    subject_code TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    PRIMARY KEY (voucher_id, seq)
  );
  CREATE TABLE voucher_evidence (
    voucher_id INTEGER NOT NULL REFERENCES voucher(id),
    role TEXT NOT NULL,
    PRIMARY KEY (voucher_id, role)
  );
  CREATE TABLE invoice (
    invoice_number TEXT PRIMARY KEY,
    issue_date TEXT,
    direction TEXT NOT NULL,
    counterparty TEXT,
    total_cents INTEGER,
    facts_json TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    voucher_id INTEGER REFERENCES voucher(id)
  );
  CREATE TABLE statement_import (
    id INTEGER PRIMARY KEY,
    account_ref TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );
  CREATE TABLE statement_line (
    id INTEGER PRIMARY KEY,
    import_id INTEGER NOT NULL REFERENCES statement_import(id),
    row_number INTEGER NOT NULL,
    occurred_on TEXT NOT NULL,
    signed_cents INTEGER NOT NULL,
    counterparty TEXT,
    description TEXT,
    voucher_id INTEGER REFERENCES voucher(id)
  );
  CREATE TABLE period_lock (
    period_key TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL
  );
  CREATE INDEX voucher_period ON voucher(period_key);
  CREATE INDEX statement_line_date ON statement_line(occurred_on);
  `,
  // 作废凭证：不删行，只打标记；作废的凭证不进余额、利润和结账检查，凭证号不复用。
  `
  ALTER TABLE voucher ADD COLUMN voided_at TEXT;
  ALTER TABLE voucher ADD COLUMN void_reason TEXT;
  `,
  // 期初余额：建账那个月月初各科目已有的余额，不是凭证，不占凭证号。
  // 流水导入时记下这段开始前的账户余额，结账时按它推出月末余额，和账上银行存款核对。
  `
  CREATE TABLE opening_balance (
    subject_code TEXT PRIMARY KEY,
    subject_name TEXT NOT NULL,
    net_debit_cents INTEGER NOT NULL
  );
  ALTER TABLE company ADD COLUMN opening_balances_set_at TEXT;
  ALTER TABLE statement_import ADD COLUMN opening_balance_cents INTEGER;
  `,
  // 业务进度与工具事实共享于同一本本地账本；换掉样本账时一同清理。
  `
  CREATE TABLE work_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
]

export interface Company {
  readonly name: string
  readonly taxId?: string
  readonly accountingStartMonth: string
  readonly isSample: boolean
}

export interface WorkEvent {
  readonly id: number
  readonly operation: string
  readonly request: Record<string, unknown>
  readonly result: Record<string, unknown>
  readonly createdAt: string
}

export interface SubjectMovement {
  readonly subjectCode: string
  readonly subjectName: string
  /** 借方合计减贷方合计，单位分。 */
  readonly netDebitCents: bigint
}

export interface VoucherRecord {
  readonly id: number
  readonly voucherNo: string
  readonly voucherDate: string
  readonly summary: string
  readonly eventKind: string
  readonly ruleId: string
  readonly requiredRoles: readonly string[]
  readonly evidenceRoles: readonly string[]
  readonly voided: boolean
  readonly legs: readonly {
    readonly direction: 'debit' | 'credit'
    readonly subjectCode: string
    readonly subjectName: string
    readonly amountCents: bigint
  }[]
}

export interface StatementImport {
  readonly id: number
  readonly accountRef: string
  readonly from: string
  readonly to: string
  /** 这段流水开始前账户里的钱，单位分。旧版本导入的流水没记，为 null。 */
  readonly openingBalanceCents: bigint | null
}

export interface StatementLine {
  readonly id: number
  readonly accountRef: string
  readonly rowNumber: number
  readonly occurredOn: string
  readonly signedCents: bigint
  readonly counterparty: string | null
  readonly description: string | null
  readonly voucherNo: string | null
}

export interface InvoiceRecord {
  readonly invoiceNumber: string
  readonly issueDate: string | null
  readonly direction: string
  readonly counterparty: string | null
  readonly totalCents: bigint | null
  /** 核票时读到的票面要素原样，见 `InvoiceReading`。 */
  readonly facts: Readonly<Record<string, unknown>>
  readonly voucherNo: string | null
}

/** 等写锁的最长时间。账本的写操作都是毫秒级，5 秒足够排队。 */
const BUSY_TIMEOUT_MS = 5000

export class BookStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    // 同一本账可能被几个 DSH 进程同时打开（终端和网页各开一个）：写锁被占时等一会儿，不直接报 database is locked。
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    // 版本号在拿到写锁以后再读：两个进程同时打开旧账本时，后到的那个不会把同一步升级再跑一遍。
    const step = () => {
      const { user_version: v } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (v >= MIGRATIONS.length) return false
      this.db.exec(MIGRATIONS[v]!)
      this.db.exec(`PRAGMA user_version = ${v + 1}`)
      return true
    }
    while (this.transaction(step));
  }

  /** 写事务。已经在事务里时直接执行，由外层提交或回滚。 */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  company(): Company | undefined {
    const row = this.db
      .prepare('SELECT name, tax_id, accounting_start_month, is_sample FROM company WHERE id = 1')
      .get() as { name: string; tax_id: string | null; accounting_start_month: string; is_sample: number } | undefined
    if (!row) return undefined
    return {
      name: row.name,
      ...(row.tax_id ? { taxId: row.tax_id } : {}),
      accountingStartMonth: row.accounting_start_month,
      isSample: row.is_sample === 1,
    }
  }

  createCompany(company: Company): void {
    this.db
      .prepare('INSERT INTO company (id, name, tax_id, accounting_start_month, is_sample) VALUES (1, ?, ?, ?, ?)')
      .run(company.name, company.taxId ?? null, company.accountingStartMonth, company.isSample ? 1 : 0)
  }

  /** 清空整本账，换一家企业重新开。只在把样本账换成老板自己的账时用。 */
  clearBook(): void {
    for (const table of [
      'work_event',
      'opening_balance',
      'statement_line',
      'statement_import',
      'invoice',
      'voucher_evidence',
      'voucher_leg',
      'voucher',
      'period_lock',
      'company_fact',
      'company',
    ])
      this.db.exec(`DELETE FROM ${table}`)
  }

  recordWork(operation: string, request: unknown, result: unknown, now = new Date()): number {
    const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v)
    return Number(this.db.prepare(
      'INSERT INTO work_event (operation, request_json, result_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(operation, json(request), json(result), now.toISOString()).lastInsertRowid)
  }

  workEvents(beforeId?: number, limit = 20): WorkEvent[] {
    const rows = this.db.prepare(
      'SELECT id, operation, request_json, result_json, created_at FROM work_event WHERE id < ? ORDER BY id DESC LIMIT ?',
    ).all(beforeId ?? Number.MAX_SAFE_INTEGER, limit) as {
      id: number; operation: string; request_json: string; result_json: string; created_at: string
    }[]
    return rows.map(row => ({
      id: row.id, operation: row.operation, request: JSON.parse(row.request_json) as Record<string, unknown>,
      result: JSON.parse(row.result_json) as Record<string, unknown>, createdAt: row.created_at,
    }))
  }

  /** 录过期初余额的时间，没录过为 undefined。录的是空表（新成立的公司）也算录过。 */
  openingBalancesSetAt(): string | undefined {
    const row = this.db.prepare('SELECT opening_balances_set_at AS at FROM company WHERE id = 1').get() as
      | { at: string | null }
      | undefined
    return row?.at ?? undefined
  }

  openingBalances(): SubjectMovement[] {
    const stmt = this.db.prepare(
      'SELECT subject_code AS code, subject_name AS name, net_debit_cents AS net FROM opening_balance ORDER BY subject_code',
    )
    stmt.setReadBigInts(true)
    return (stmt.all() as { code: string; name: string; net: bigint }[]).map((r) => ({
      subjectCode: r.code,
      subjectName: r.name,
      netDebitCents: r.net,
    }))
  }

  /** 整体替换期初余额。 */
  setOpeningBalances(rows: readonly SubjectMovement[], now: Date): void {
    this.db.exec('DELETE FROM opening_balance')
    const insert = this.db.prepare('INSERT INTO opening_balance (subject_code, subject_name, net_debit_cents) VALUES (?, ?, ?)')
    for (const r of rows) insert.run(r.subjectCode, r.subjectName, r.netDebitCents)
    this.db.prepare('UPDATE company SET opening_balances_set_at = ? WHERE id = 1').run(now.toISOString())
  }

  companyFacts(): Record<string, string> {
    const rows = this.db.prepare('SELECT fact_key, value FROM company_fact').all() as {
      fact_key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.fact_key, r.value]))
  }

  setCompanyFact(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO company_fact (fact_key, value) VALUES (?, ?) ON CONFLICT(fact_key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /**
   * 落一张凭证。凭证号按期间连续编：`PZ-202603-001`。
   * 同一 `eventId` 只能记一次，重复记会被唯一约束挡下。金额为零的腿不落。
   */
  postVoucher(input: {
    readonly periodKey: string
    readonly voucherDate: string
    readonly summary: string
    readonly eventKind: string
    readonly facts: Readonly<Record<string, string>>
    readonly posting: LedgerPosting
    readonly requiredRoles: readonly string[]
    readonly evidenceRoles: readonly string[]
    readonly now: Date
  }): { id: number; voucherNo: string } {
    const { periodKey, posting } = input
    const count = this.db.prepare('SELECT count(*) AS n FROM voucher WHERE period_key = ?').get(periodKey) as {
      n: number
    }
    const voucherNo = `PZ-${periodKey.replace('-', '')}-${String(count.n + 1).padStart(3, '0')}`
    const inserted = this.db
      .prepare(
        `INSERT INTO voucher (period_key, voucher_no, voucher_date, summary, event_id, event_kind, facts_json,
                              rule_id, pack_ref, required_roles_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        periodKey,
        voucherNo,
        input.voucherDate,
        input.summary,
        posting.eventId,
        input.eventKind,
        JSON.stringify(input.facts),
        posting.ruleId,
        posting.packRef,
        JSON.stringify(input.requiredRoles),
        input.now.toISOString(),
      )
    const id = Number(inserted.lastInsertRowid)
    const leg = this.db.prepare(
      `INSERT INTO voucher_leg (voucher_id, seq, direction, subject_code, subject_name, amount_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    posting.legs.forEach((l, seq) => {
      const cents = parseAmountToCents(l.amount)
      if (cents === undefined) throw new Error(`金额格式不对：${l.amount}`)
      if (cents !== 0n) leg.run(id, seq, l.direction, l.subjectCode, l.subjectName, cents)
    })
    for (const role of new Set(input.evidenceRoles)) this.addEvidence(id, role)
    return { id, voucherNo }
  }

  /** 记在某张凭证名下（facts 里 `key` 等于凭证号）、没作废的凭证号，用来查冲销和更正。 */
  voucherLinkedTo(key: 'correction.reverses' | 'correction.of', voucherNo: string): string | undefined {
    const row = this.db
      .prepare(`SELECT voucher_no FROM voucher WHERE voided_at IS NULL AND json_extract(facts_json, '$."' || ? || '"') = ?`)
      .get(key, voucherNo) as { voucher_no: string } | undefined
    return row?.voucher_no
  }

  addEvidence(voucherId: number, role: string): void {
    this.db.prepare('INSERT OR IGNORE INTO voucher_evidence (voucher_id, role) VALUES (?, ?)').run(voucherId, role)
  }

  /** 某月没作废的凭证（或凭证号指定的那一张，作废的也查得到），按凭证号排。 */
  vouchers(filter: { readonly periodKey: string } | { readonly voucherNo: string }): VoucherRecord[] {
    const where = 'periodKey' in filter ? 'period_key = ? AND voided_at IS NULL' : 'voucher_no = ?'
    const value = 'periodKey' in filter ? filter.periodKey : filter.voucherNo
    const rows = this.db
      .prepare(
        `SELECT id, voucher_no, voucher_date, summary, event_kind, rule_id, required_roles_json, voided_at
         FROM voucher WHERE ${where} ORDER BY voucher_no`,
      )
      .all(value) as {
      id: number
      voucher_no: string
      voucher_date: string
      summary: string
      event_kind: string
      rule_id: string
      required_roles_json: string
      voided_at: string | null
    }[]
    const legStmt = this.db.prepare(
      'SELECT direction, subject_code, subject_name, amount_cents FROM voucher_leg WHERE voucher_id = ? ORDER BY seq',
    )
    legStmt.setReadBigInts(true)
    const evidenceStmt = this.db.prepare('SELECT role FROM voucher_evidence WHERE voucher_id = ? ORDER BY role')
    return rows.map((r) => ({
      id: r.id,
      voucherNo: r.voucher_no,
      voucherDate: r.voucher_date,
      summary: r.summary,
      eventKind: r.event_kind,
      ruleId: r.rule_id,
      requiredRoles: JSON.parse(r.required_roles_json) as string[],
      evidenceRoles: (evidenceStmt.all(r.id) as { role: string }[]).map((e) => e.role),
      voided: r.voided_at !== null,
      legs: (
        legStmt.all(r.id) as {
          direction: 'debit' | 'credit'
          subject_code: string
          subject_name: string
          amount_cents: bigint
        }[]
      ).map((l) => ({
        direction: l.direction,
        subjectCode: l.subject_code,
        subjectName: l.subject_name,
        amountCents: l.amount_cents,
      })),
    }))
  }

  /** 账上有凭证的月份，从早到晚。 */
  postedPeriods(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT period_key FROM voucher WHERE voided_at IS NULL ORDER BY period_key')
      .all() as {
      period_key: string
    }[]
    return rows.map((r) => r.period_key)
  }

  /**
   * 各科目的借贷净额，范围是 `fromPeriod`（含，省略时从建账起，连期初余额一起算）到 `toPeriod`（含）。
   * `excludeEventKinds` 里的凭证不算，查利润时用它排除损益结转。
   */
  movements(toPeriod: string, fromPeriod = '', excludeEventKinds: readonly string[] = []): SubjectMovement[] {
    const placeholders = excludeEventKinds.map(() => '?').join(', ')
    const stmt = this.db.prepare(
      `SELECT code, max(name) AS name, sum(net) AS net FROM (
         SELECT l.subject_code AS code, l.subject_name AS name,
                CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END AS net
         FROM voucher_leg l JOIN voucher v ON v.id = l.voucher_id
         WHERE v.period_key <= ? AND v.period_key >= ? AND v.voided_at IS NULL
           ${excludeEventKinds.length ? `AND v.event_kind NOT IN (${placeholders})` : ''}
         UNION ALL
         SELECT subject_code, subject_name, net_debit_cents FROM opening_balance WHERE ? = ''
       ) GROUP BY code ORDER BY code`,
    )
    stmt.setReadBigInts(true)
    const rows = stmt.all(toPeriod, fromPeriod, ...excludeEventKinds, fromPeriod) as { code: string; name: string; net: bigint }[]
    return rows.map((r) => ({ subjectCode: r.code, subjectName: r.name, netDebitCents: r.net }))
  }

  saveInvoice(input: {
    readonly invoiceNumber: string
    readonly issueDate: string | null
    readonly direction: string
    readonly counterparty: string | null
    readonly totalCents: bigint | null
    readonly facts: unknown
    readonly now: Date
  }): void {
    this.db
      .prepare(
        `INSERT INTO invoice (invoice_number, issue_date, direction, counterparty, total_cents, facts_json, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(invoice_number) DO UPDATE SET issue_date = excluded.issue_date, direction = excluded.direction,
           counterparty = excluded.counterparty, total_cents = excluded.total_cents, facts_json = excluded.facts_json,
           checked_at = excluded.checked_at
         WHERE invoice.voucher_id IS NULL`,
      )
      .run(
        input.invoiceNumber,
        input.issueDate,
        input.direction,
        input.counterparty,
        input.totalCents,
        JSON.stringify(input.facts),
        input.now.toISOString(),
      )
  }

  invoice(invoiceNumber: string): InvoiceRecord | undefined {
    const stmt = this.db.prepare(
      `SELECT i.invoice_number, i.issue_date, i.direction, i.counterparty, i.total_cents, i.facts_json, v.voucher_no
       FROM invoice i LEFT JOIN voucher v ON v.id = i.voucher_id WHERE i.invoice_number = ?`,
    )
    stmt.setReadBigInts(true)
    const row = stmt.get(invoiceNumber) as
      | {
          invoice_number: string
          issue_date: string | null
          direction: string
          counterparty: string | null
          total_cents: bigint | null
          facts_json: string
          voucher_no: string | null
        }
      | undefined
    return (
      row && {
        invoiceNumber: row.invoice_number,
        issueDate: row.issue_date,
        direction: row.direction,
        counterparty: row.counterparty,
        totalCents: row.total_cents,
        facts: JSON.parse(row.facts_json) as Record<string, unknown>,
        voucherNo: row.voucher_no,
      }
    )
  }

  attachInvoice(invoiceNumber: string, voucherId: number): void {
    this.db.prepare('UPDATE invoice SET voucher_id = ? WHERE invoice_number = ?').run(voucherId, invoiceNumber)
  }

  /** 开票日期在某段时间里的发票，可按进项（input）、销项（output）筛。 */
  invoices(filter: { from: string; to: string; direction?: string }): InvoiceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT invoice_number FROM invoice WHERE issue_date >= ? AND issue_date <= ? ${filter.direction ? 'AND direction = ?' : ''}
         ORDER BY issue_date, invoice_number`,
      )
      .all(filter.from, filter.to, ...(filter.direction ? [filter.direction] : [])) as { invoice_number: string }[]
    return rows.map((r) => this.invoice(r.invoice_number)!)
  }

  /** 已核对过、还没记进任何凭证的发票。 */
  pendingInvoices(): InvoiceRecord[] {
    const rows = this.db.prepare('SELECT invoice_number FROM invoice WHERE voucher_id IS NULL ORDER BY issue_date').all() as {
      invoice_number: string
    }[]
    return rows.map((r) => this.invoice(r.invoice_number)!)
  }

  importStatement(input: {
    readonly accountRef: string
    readonly periodStart: string
    readonly periodEnd: string
    readonly openingBalanceCents: bigint
    readonly lines: readonly {
      readonly rowNumber: number
      readonly occurredOn: string
      readonly signedCents: bigint
      readonly counterparty?: string | undefined
      readonly description?: string | undefined
    }[]
    readonly now: Date
  }): number {
    const inserted = this.db
      .prepare(
        'INSERT INTO statement_import (account_ref, period_start, period_end, opening_balance_cents, imported_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.accountRef, input.periodStart, input.periodEnd, input.openingBalanceCents, input.now.toISOString())
    const importId = Number(inserted.lastInsertRowid)
    const line = this.db.prepare(
      `INSERT INTO statement_line (import_id, row_number, occurred_on, signed_cents, counterparty, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const l of input.lines)
      line.run(importId, l.rowNumber, l.occurredOn, l.signedCents, l.counterparty ?? null, l.description ?? null)
    return importId
  }

  /** 已导入的流水各覆盖哪个账户的哪些日子。 */
  statementCoverage(): StatementImport[] {
    const stmt = this.db.prepare(
      'SELECT id, account_ref, period_start, period_end, opening_balance_cents FROM statement_import ORDER BY period_start, id',
    )
    stmt.setReadBigInts(true)
    return (
      stmt.all() as { id: bigint; account_ref: string; period_start: string; period_end: string; opening_balance_cents: bigint | null }[]
    ).map((r) => ({
      id: Number(r.id),
      accountRef: r.account_ref,
      from: r.period_start,
      to: r.period_end,
      openingBalanceCents: r.opening_balance_cents,
    }))
  }

  renameStatementAccount(from: string, to: string): void {
    this.db.prepare('UPDATE statement_import SET account_ref = ? WHERE account_ref = ?').run(to, from)
  }

  /** 流水行，可按导入批次或日期范围筛。 */
  statementLines(filter: { importId?: number; from?: string; to?: string; ids?: readonly number[] }): StatementLine[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.importId !== undefined) {
      where.push('s.import_id = ?')
      params.push(filter.importId)
    }
    if (filter.from !== undefined) {
      where.push('s.occurred_on >= ?')
      params.push(filter.from)
    }
    if (filter.to !== undefined) {
      where.push('s.occurred_on <= ?')
      params.push(filter.to)
    }
    if (filter.ids !== undefined) {
      where.push(`s.id IN (${filter.ids.map(() => '?').join(', ') || 'NULL'})`)
      params.push(...filter.ids)
    }
    const stmt = this.db.prepare(
      `SELECT s.id, i.account_ref, s.row_number, s.occurred_on, s.signed_cents, s.counterparty, s.description, v.voucher_no
       FROM statement_line s JOIN statement_import i ON i.id = s.import_id LEFT JOIN voucher v ON v.id = s.voucher_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.occurred_on, s.id`,
    )
    stmt.setReadBigInts(true)
    const rows = stmt.all(...params) as {
      id: bigint
      account_ref: string
      row_number: bigint
      occurred_on: string
      signed_cents: bigint
      counterparty: string | null
      description: string | null
      voucher_no: string | null
    }[]
    return rows.map((r) => ({
      id: Number(r.id),
      accountRef: r.account_ref,
      rowNumber: Number(r.row_number),
      occurredOn: r.occurred_on,
      signedCents: r.signed_cents,
      counterparty: r.counterparty,
      description: r.description,
      voucherNo: r.voucher_no,
    }))
  }

  /** 作废一张凭证，并把挂在它上面的发票和流水解开，之后可以重新记。 */
  voidVoucher(voucherId: number, reason: string, now: Date): void {
    this.db.prepare('UPDATE voucher SET voided_at = ?, void_reason = ? WHERE id = ?').run(now.toISOString(), reason, voucherId)
    this.db.prepare('UPDATE invoice SET voucher_id = NULL WHERE voucher_id = ?').run(voucherId)
    this.db.prepare('UPDATE statement_line SET voucher_id = NULL WHERE voucher_id = ?').run(voucherId)
  }

  attachStatementLine(lineId: number, voucherId: number): void {
    this.db.prepare('UPDATE statement_line SET voucher_id = ? WHERE id = ?').run(voucherId, lineId)
  }

  lockedPeriods(): string[] {
    return (this.db.prepare('SELECT period_key FROM period_lock ORDER BY period_key').all() as { period_key: string }[]).map(
      (r) => r.period_key,
    )
  }

  lockPeriod(periodKey: string, now: Date): void {
    this.db.prepare('INSERT INTO period_lock (period_key, locked_at) VALUES (?, ?)').run(periodKey, now.toISOString())
  }
}
