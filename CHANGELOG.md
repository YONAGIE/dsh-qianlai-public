# Changelog

## Unreleased

- Read the PDF referenced in the current Zhangjie turn from the DSH Desktop file picker or chat composer drop. DSH asks before reading a PDF outside the workspace.

- Surface manual accounting review in the closing checklist and review export for required month-end items whose posting rules all require unsupported historical balances.

- Distinguish cancellation of an erroneous posting from a planned replacement. An explicitly scheduled correction blocks closing its designated month until the replacement is posted.

- Validate purchase/sales invoice direction, check original evidence on corrections and reject all-zero postings. Match bank inflows and outflows separately before attaching statement rows.
- Block personal-advance repayments when the original advance, payer, payment evidence and remaining balance cannot be verified per transaction. The posting guide exposes this limitation. Recording an employee-paid expense remains available.
- Quarterly filing preparation distinguishes unreadable amounts from zero, groups equivalent tax rates, and reports a partial quarter when the book starts mid-quarter.
- Decode BOM-marked UTF-16LE/BE statement text and clarify which spreadsheet fixtures are valid or corrupted.

- Resume unfinished WeChat onboarding for older bindings and generate read-only task-continuation messages from the explicitly originating Zhangjie conversation through the existing Agent. Deduplicate completed greetings/images, retain failed deliveries and recover completed summaries after restart. No send-result panel or display is added.

- Resolve WeChat login-QR requests through the current dedicated tool, distinguish it from general image generation, and correct obsolete capability claims from earlier conversations without rewriting history.

- Align contribution and security scope with the source packages and local build environment now present, while preserving private reporting and copied-core maintenance rules.

- Bound WeChat media reception to 20 MB across declared sizes, headers, streamed ciphertext and decrypted bytes; cancel oversized transfers and request compression/splitting instead of reporting a network failure. The existing 8 MB document parsing limit is unchanged.

- Reject unsafe numeric-to-string parameter conversion and out-of-range invoice adapter amounts before Number conversion; retain original long strings and exact supported amounts instead of returning rounded values.

- Clarify month/year intent before querying, including in clarification questions; do not treat the assistant's suggested year as user confirmation. Add live-model regression with explicit non-sample years and known-year controls.

- Add explicit synthetic approval modes to the live-model runner, direct Node/DSH CLI selection for Windows, and Unicode-safe session-log reads; test answerers are not loaded in production.

- Apply declared parameter types to every caller-owned JSON dictionary key and require actual own fields for required properties.

- Require DSH-native approval for critical ledger writes, reject stale/cancelled approvals, and return persistent per-call receipts instead of executing the same accepted call twice.

- Retain unacknowledged WeChat reply fragments in the private channel state, retry with stable client identities, and resume pending sends after restart without rerunning business operations.

- Keep failed WeChat batches unacknowledged, persist recent admitted identities, and reuse DSH request deduplication for message retries and restarts.

- Publish review exports as unique, completed snapshots; failed writes leave no partial export and repeated exports never overwrite earlier deliveries.

- Bundle the existing official SheetJS CE build and license in compiled uploads; remove its exotic URL runtime subdependency so pnpm 12 can install archives with default protection.
- Restore local build-and-pack delivery using pnpm's native recursive pack command; write both workspace archives to the root dist directory without publishing.
- Prevent voiding a reversal while its correction remains active; allow rollback in the opposite order when both periods are open.
- Reserve correction relationship facts for the dedicated reversal/correction workflow instead of accepting them from ordinary business facts.
- Validate declared tool argument enums recursively before execution, including WeChat action selection.
- Require a valid active reversal before correction and reject correction periods earlier than the reversal, including previews.
- Allow balance, profit, statement and review-pack reads for confirmed opening balances and closed zero-activity periods without inventing later periods.
- Require confirmed opening balances and an ended accounting month in China time before locking a period; expose both blockers in closing checks and review exports.
- Honor public unreadable amount fields before parsing; never persist uncertain monetary candidates as verified invoice facts or use missing invoice amounts for posting.
- Validate the cumulative statement amount attached to a voucher; make identical link retries idempotent and reject empty evidence links.
- Reject caller-supplied invoice/settlement evidence roles when previewing or posting; preserve automatic evidence from checked invoice and statement links.
- Exercise attachment path-escape protection on ordinary Windows accounts using a directory junction test fixture.
- Add an authenticated, on-demand WeChat QR panel with live status, expiration and refresh, plus a scoped login tool.
- Read XLS/XLSX worksheets and paginated PDF text/page images directly from received attachments; preserve validation and posting confirmation.
- Persist local-book business progress, material references and explicitly unverified continuation notes across sessions and restarts.
- Clarify ambiguous months/years and prevent fabricated persona life stories or false acknowledgements of earlier promises.
- Attempt a resumable first-binding WeChat welcome with three bundled portraits and recent book activity. Real account delivery without an inbound context token remains unverified; see docs/validation/open-issues-2026-11-01.md.
- Upgrade the Zod runtime dependency to the patched 4.6.7 range for GHSA-mrhx-c7xc-m3w5; copied financial-core source remains unchanged.
- Import the latest source snapshot, existing fixes, synthetic fixtures and sanitized Q-008 reproduction kit.
- Preserve five prior PR change/validation records and migrate historical issues under public rules.
- Add local validation instructions; preserve historical CI as an inactive archive.
- This source integration is not a package release; see docs/history/migration.md.

## Repository foundation (historical)

- Establish the public dsh-qianlai community repository.
- Add bilingual project status, contribution guidance, issue forms and support policies.
- Configure feedback and private reporting channels.

At the foundation milestone, plugin source had not been imported. This entry does not represent a plugin
version, release tag or installable artifact.

以上历史条目仅说明建仓阶段；当前源码接入候选也不代表插件版本发布。
