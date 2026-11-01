# Zhangjie · dsh-qianlai

[中文](README.zh.md)

A third-party small-business finance assistant plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Source integration candidate; no npm package or Release is published by this import.** Source snapshot: `dad68cf856fae0bb2bb2ea954f6e9400a0e69098`. See the [migration ledger](docs/history/migration.md), [prior PR records](docs/history/legacy-prs.md), and [import review](docs/history/import-review.json).

## Scope

One local SQLite book per company; synthetic sample book, invoice consistency checks, bank-statement import, opening balances, preview/confirmed posting, balances/profit, simple reports, closing, reversals and CSV review export. Read XLS/XLSX and paginated PDF text/page images directly. An authenticated WeChat QR panel supports refresh and live status. Business events, material references and unverified notes support continuation across sessions sharing one local book; separate computers or DSH homes do not synchronize. First binding attempts a resumable welcome with three bundled portraits. Live model and real-account delivery limits are recorded in [validation notes](docs/validation/open-issues-2026-11-01.md). See [package documentation](packages/dsh-qianlai/README.md). This does not replace an accountant or execute tax filing/payments. Model conversations and attachments use the configured external model/channel services.

## Build and validate

Use Node 22.x >=22.19 or Node >=24, and the declared pnpm 12.3.4.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
node packages/dsh-qianlai/e2e/q008/run.mjs --validate
```

After building, install the absolute path of `packages/dsh-qianlai` through the DSH desktop plugin page or `dsh plugin --profile web add /absolute/path/to/packages/dsh-qianlai`. Do not install the workspace root. Use an isolated DSH_HOME. Workspace dependency distribution/npm installation is a separate release milestone.

## Tests and contribution

The [Q-008 reproduction kit](packages/dsh-qianlai/e2e/q008/README.md) includes fixed synthetic prompts, three frozen personas and selected visible replies. Offline validation needs no key. Paid live-model runs are explicit and use only the tester's DEEPSEEK_API_KEY environment variable. Never submit credentials, private conversations or real financial records.

Follow [CONTRIBUTING](CONTRIBUTING.md), the [issue guide](docs/issue-reporting.md), and the existing PR template. Hosted CI is intentionally not enabled under the current maintenance rules; the historical workflow is archived as a non-workflow file. Historical checks and this import's local results are distinguished.

Code uses [Apache-2.0](LICENSE). Zhangjie artwork remains separately restricted to display inside this plugin; retain [NOTICE](NOTICE) and [asset notices](packages/dsh-qianlai/assets/zhangjie/NOTICE.md). Community-maintained, not an official DeepSeek product. See [maintainers](MAINTAINERS.md), [support](SUPPORT.md), [roadmap](ROADMAP.md) and [security reporting](SECURITY.md).
