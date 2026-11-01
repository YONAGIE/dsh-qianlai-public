---
description: "Zhangjie by Qianlai: a bookkeeping assistant mode for small Chinese companies, with one local SQLite ledger and an optional WeChat channel."
kind: "package-bundle"
---

# dsh-qianlai

English | [中文](README.zh.md)

## Summary

Adds a "钱来张姐" (Zhangjie) mode to DeepSeek Harness. In that mode the agent keeps one set of books on the local machine for a small-scale VAT taxpayer: it checks invoices, imports bank statements, posts vouchers from a bundled accounting pack, reports balances and profit, and runs month-end checks before closing. Selecting the mode switches the Web UI to the Qianlai green palette and shows Zhangjie's avatar in the session header. The WeChat host plugin connects on demand; separate sessions sharing this local book can resume business work from persisted progress.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```sh
dsh plugin --profile web add /absolute/path/to/dsh-qianlai/packages/dsh-qianlai
export DEEPSEEK_API_KEY=your-key
dsh --profile web
```

Open the printed URL, pick **钱来张姐** in the mode picker above the input box, and start a session. The first start creates fictional sample books; ask Zhangjie to open your own company's books when you are ready, and she clears the sample after you agree.

Select Zhangjie and click **连接微信** → **获取二维码**. Scan with the owner’s WeChat; status updates live and expired codes can be refreshed. An explicit request to Zhangjie can also start login. `MONEYCOME_WECHAT=1` retains automatic terminal QR login. A different scanner cannot take over the existing book.

First binding attempts a welcome and three savable bundled portraits. Robot remark/avatar settings depend on the actual WeChat version; the plugin never changes your personal profile. If the server requires an inbound context token, send the bot a message to resume unfinished welcome steps. Successful steps are persisted, preventing restart duplication of completed welcomes; context-free delivery still requires real-account verification.

Data lives under `$DSH_HOME/moneycome/` (`~/.dsh/moneycome/` by default): `book.sqlite` for the books and `wechat.json` for the WeChat login. Stop DSH before copying `book.sqlite` as a backup.

Full user documentation: [repository README](https://github.com/qianlai-ai/dsh-qianlai#readme).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts three entries:

| Entry | Layer | What it does |
|---|---|---|
| `preset-moneycome-zhangjie` | agent preset | The mode: a persona prefix plus this package's tools. No shell, file-system or web tools. |
| `moneycome-ui` | host, `mode: ui` | Loads the browser half (`client/client.src.js`): avatar in the session header and a token override on `ctx.theme` while a Zhangjie session or the Zhangjie choice on the new-session page is shown. |
| `moneycome-wechat` | host | `dsh-qianlai/wechat`, loaded by default with on-demand login; `MONEYCOME_WECHAT=1` enables automatic QR login. Long-polls Tencent iLink and forwards owner messages to a dedicated session through `sessionController`. |

Domain rules come from [`@moneycome/fintax-core`](../fintax-core/README.md) and the accounting pack in `assets/packs/`. The plugin writes no subject codes of its own; the bank subject, profit lines and closing items are read from the pack.

The books are one SQLite file opened with `node:sqlite` in WAL mode. Amounts are stored as integer cents. Schema versions live in `PRAGMA user_version`; migrations are appended to `MIGRATIONS` in `src/store.ts`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

The Zhangjie preset includes a Chinese persona and 27 business tools. All tools are prefixed `moneycome_`:

- Book: `book_status`, `open_book`, `set_opening_balances`, `set_company_facts`
- Reading: `read_balances`, `read_profit`, `financial_statements`, `list_vouchers`, `unrecorded_statement_lines`, `posting_guide`
- For the accountant and the tax calendar: `export_review_pack`, `upcoming`, `quarter_filing_prep`
- Materials: `check_invoice`, `read_upload`, `import_statement`, `rename_bank_account`
- Writing: `record_entry` (with `preview` and `correctsVoucherNo`), `link_statement`, `add_evidence`, `void_voucher`, `reverse_voucher`
- Month end: `closing_check`, `close_period`
- Continuation and WeChat: `work_progress`, `save_work_note`, `wechat`

Every figure the model reports comes from a tool result. Business refusals (closed month, unbalanced entry, unknown subject and so on) come back as `accepted: false` with a `code` and a plain-language `message`. Arguments of the wrong type return `ARGUMENT_INVALID` naming the field. Synchronous business calls run in one write transaction; attachment parsing uses a timed worker without holding the book write lock; an unexpected error such as a database failure rolls the whole call back and returns `TOOL_FAILED`. When several DSH processes open the same book (say a terminal and a browser), writes queue for up to 5 seconds. Text inside invoices, statements and uploads is passed as data and the persona tells the model not to follow instructions found there.

#### Token effect

The persona and tool catalog are sent with every request in a Zhangjie session. Tool results are compact JSON; a closing check on a busy month is the largest, listing each unrecorded statement line.

#### KV Cache effect

The persona and tool catalog are static, so they stay in the cached prefix. Nothing in this package rewrites earlier messages.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- One company per machine; no accounts, roles or approval flow.
- Postings that depend on earlier balances (depreciation, prepaid expense amortisation, accrued expenses) are not supported, so companies with fixed assets or prepaid expenses cannot close a month yet.
- Closed months cannot be reopened; errors found later are fixed with a reversing voucher and a correcting entry in an open month.
- Filing reminders track dates only; the plugin does not know whether a return has been filed, and the filing prep sheet totals the books without computing tax.
- The invoice check verifies internal consistency only, not authenticity with the tax bureau.
- Supports CSV/TSV/TXT, XLS/XLSX and text, scanned or mixed PDFs, retaining the 8 MB input limit. Excel exposes row/sheet continuation; PDFs expose page text and images. Formulas use saved cached values only. Encrypted, damaged or unreadable materials need clarification or replacement; reading does not import or post.
- Progress and material references are shared only within one local book and DSH home, without cross-machine synchronization. Notes remain unverified and cannot replace current preview/confirmation. Replacing sample books clears their old progress.
- The accounting pack is an unreviewed engineering candidate with placeholder signatures.
- The WeChat channel uses Tencent's iLink message format and may break when Tencent changes it.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

`pnpm build` compiles `src/` with `tsc` and inlines the avatar into `lib/client.js` (`scripts/build-client.mjs`). Unit tests use in-memory SQLite and a fake iLink server. `e2e/run.mjs` drives real DeepSeek sessions against scripted conversations and is not part of CI.

</details>
