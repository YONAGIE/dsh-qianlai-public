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

In a Zhangjie conversation in DSH Desktop, choose a PDF with the chat composer's file picker or drop it directly into the composer, then send the message. Zhangjie can read one PDF up to 8 MB per turn. Full access allows the tool to read that turn's referenced PDF outside the workspace directly. With workspace-write permissions, DSH asks before reading an external PDF.

For local package inspection, `pnpm pack:all` builds both packages and uses pnpm's native recursive pack to write `moneycome-fintax-core-0.1.0.tgz` and `dsh-qianlai-0.1.0.tgz` to the root `dist/` directory. The plugin archive declares the matching core version; a local archive consumer must resolve it to the supplied core archive (for example using a package-manager override). This command does not publish either package or establish registry-install availability.

Then run `pnpm test:packages` to install those archives in a fresh temporary consumer with the core override, keeping pnpm's default supply-chain protection. It checks tool loading, Chinese XLS/XLSX and CSV reads, the WeChat export, and bundled SheetJS/license byte identity. It may fetch registry metadata/dependencies, disables install lifecycle scripts, uses no model or real account, and cleans its consumer directory. SheetJS CE remains the existing official 0.20.3 build, bundled at compile time instead of an exotic runtime URL dependency.

WeChat retries failed batches using stable message/request identities. Unacknowledged reply fragments are retained privately in `moneycome/wechat.json` and retried after reconnect/restart; acknowledged fragments are removed. This file contains credentials and pending business replies: never attach it publicly. Delivery still depends on the remote service's client-ID handling, and replies lost before persistence cannot be recovered; do not rerun business actions merely to resend a reply.

Opening “连接微信” requests a QR when needed, preserving an existing login. First binding and older bindings with unfinished onboarding attempt the welcome and three bundled images, resuming after an inbound message if the backend requires a context token. Completed greetings are not repeated. Explicit connection from a Zhangjie conversation also binds that source conversation for one Agent-generated business-continuation message, including plans not yet written to the journal. Only bounded visible messages and current local-book progress are used; unrelated presets, system prompts and reasoning are excluded. Introduction turns cannot mutate the ledger or reset login, and do not replace later owner approval. Background status polling does not generate introductions. No send-result display is added; separate homes/computers still do not synchronize.

WeChat media reception is limited to 20 MB per item; oversized media requires compression or splitting. Document parsing retains its existing 8 MB limit. Receiving a file does not mean it has been parsed or posted.

Opening a book, replacing opening balances, posting, voiding, reversing and closing require DSH-native approval under the host's configured policy; missing approval capabilities fail closed. Queries and posting previews remain available. Desktop/web use the host interaction; WeChat sends the exact action and a five-minute nonce to the bound owner, consuming confirmation outside the model. Cancellation, expiry and restart invalidate it. Ledger changes during approval require fresh review. Persistent host-call receipts make retries return the original result; separate approved calls are not deduplicated merely because their amounts/text match.

List paid live scenarios with `node packages/dsh-qianlai/e2e/run.mjs --list`; supply only your `DEEPSEEK_API_KEY` environment variable for live runs. On Windows, `DSH_ENTRY` selects the installed DSH `lib/bin.js` using the current Node (override it with `DSH_BIN`), and `ZSTD_BIN` can select zstd; stdin log decoding supports Unicode paths. Explicit `E2E_APPROVAL_MODE=allow` with `native-approval-flow`, or `reject` with `native-approval-rejection`, loads a synthetic answerer only in a fresh test home. Other financial scenarios can use those explicit modes too. Without a mode, normal host approval may wait for interaction. Choose a fresh `E2E_OUT`; existing scenario data is refused. Test answerers are absent from production configuration and do not replace real-user acceptance.

Run `node packages/dsh-qianlai/e2e/run.mjs wechat-qr-` for dedicated QR-capability regression: real DSH/model, explicitly isolated synthetic iLink, ordinary QR requests, obsolete-capability claims and already-connected controls. `E2E_REPEAT=3` repeats each scenario; `E2E_PORT=0` allocates free ports. Use a fresh `E2E_OUT`. This does not rewrite old conversations or verify real-account scanning.

After building, `node packages/dsh-qianlai/e2e/check-wechat-approval.mjs` uses `DEEPSEEK_API_KEY`, `DSH_ENTRY` and a separate temporary home to exercise preview, native approval, owner nonce, one posting and reply with real DSH/model and synthetic iLink only. It does not load an automatic approval answerer or use a real WeChat account, and cleans its home. Real scanning and server delivery still require separate acceptance.

`node packages/dsh-qianlai/e2e/check-wechat-onboarding.mjs` uses the same key/CLI variables plus `ZSTD_BIN`, real DSH/model and synthetic iLink to test welcomes/images, source-conversation handoff, unchanged ledger and restart deduplication, both with and without a simulated inbound-context requirement. `E2E_REPEAT=2` repeats each path; `E2E_OUT` saves synthetic results. Review the emitted desktop discussion and WeChat reply for factual status and an actual continuation invitation; keyword checks are not semantic acceptance. This does not establish Tencent's context-free first-send policy or replace real-account acceptance.

## Tests and contribution

The [business regression plan and results (Chinese)](docs/validation/business-regression.zh.md) include a runnable synthetic accounting flow, independent expected totals, channel scenarios and outstanding live acceptance.

The [Q-008 reproduction kit](packages/dsh-qianlai/e2e/q008/README.md) includes fixed synthetic prompts, three frozen personas and selected visible replies. Offline validation needs no key. Paid live-model runs are explicit and use only the tester's DEEPSEEK_API_KEY environment variable. Never submit credentials, private conversations or real financial records.

Follow [CONTRIBUTING](CONTRIBUTING.md), the [issue guide](docs/issue-reporting.md), and the existing PR template. Hosted CI is intentionally not enabled under the current maintenance rules; the historical workflow is archived as a non-workflow file. Historical checks and this import's local results are distinguished.

Code uses [Apache-2.0](LICENSE). Zhangjie artwork remains separately restricted to display inside this plugin; retain [NOTICE](NOTICE) and [asset notices](packages/dsh-qianlai/assets/zhangjie/NOTICE.md). Community-maintained, not an official DeepSeek product. See [maintainers](MAINTAINERS.md), [support](SUPPORT.md), [roadmap](ROADMAP.md) and [security reporting](SECURITY.md).
