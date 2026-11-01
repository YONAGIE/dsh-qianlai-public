# Changelog

## Unreleased

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
