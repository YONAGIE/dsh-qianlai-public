# Changelog

## Unreleased

- Prepare and download monthly financial reports and ledger-detail XLSX files in Zhangjie conversations. Confirmed workbooks remain available as separate versions.
- Show which transaction or voucher needs evidence and let the user select the missing file from the report card.
- Describe actual workbook sheets and saved versions. Bank transactions without a voucher appear on the bank transactions sheet with a blank voucher reference.

- Jump directly to a year or month in both setup forms. Use the same calendar for company and bank dates, and choose bookkeeping months without selecting a day.

- Use one structured interaction at a time for Zhangjie's desktop and web follow-ups. Reuse known facts and receipts, use a choice for decisions or a form for missing fields, and keep unresolved items pending when a control is unavailable.

- Show the entry in a native choice card in full-access conversations or an approval card when the workspace requires permission. A ready-to-post voucher waits for one confirmation.

- Let a submitted native question free the current confirmation slot, so the next business fact can be reviewed after a valid answer. Keep deferred or unanswered items pending.
- Use a native business choice for an unconfirmed voucher in full-access conversations. Bind the choice and save to that exact voucher and current ledger.

- Select, drop or paste bank account documents on the setup chat card. Review extracted account details before saving them to the company draft.

- Format WeChat replies as readable paragraphs. Expand each Markdown table row into a labeled record and split long replies at paragraph or line boundaries where possible.

- Read and correct one field of a completed company profile in chat. Keep bank numbers masked and preserve leading zeros when correcting a registered tail. Show the saved value in the profile without reopening setup.

- Open a fresh form when a company profile correction is requested again. Reopen saved or expired correction cards using the latest profile values.

- Introduce Zhangjie when first-time users greet her and let them choose tax QR login or manual company setup in chat.

- Start new data directories with an empty book. Present first greetings as an introduction, a short list of capabilities, and the next action. Use the current onboarding card and its status to guide each step. Place the current setup card after the reply text and wait for a clarification answer before offering a later action.

- Continue company setup in a new reply after each chat card submission. Show the method picker at the start and accept later switches by chat while preserving the draft. Open the official QR page automatically after confirming a supported region.

- Show the same onboarding card only once per reply, including when multiple tool calls return the same tax scan or a document step.

- Show editable draft fields directly in DSH’s right-hand panel. Open the panel in the current conversation when the user starts or explicitly resumes company setup. Keep unsaved input while chat updates the other fields and show conflicting changes before saving. Lay out short fields side by side when the card is wide enough. Align primary card actions to the right and keep bank account save/defer buttons in one wrapping row.

- Align both setup forms with the web tax profile fields and options. Require a specific description for “Other” tax statuses and accounting systems. Ask for province and city when selecting a tax portal.

- Improve the visual hierarchy of company setup cards and sidebar forms. Emphasize the current action and give confirmation and field errors clear treatment.

- Combine typing, file selection, dropping, and pasting a license or tax document on one chat card. Preview extracted fields on the card and update the draft after confirmation. Documents sent in chat also get a review card. Close the host drag overlay when a file reaches the card, and show recognition progress inside the card.

- Show recognition progress and errors next to the selected license, tax or bank document. Keep the form editable while reading, and offer to retry or replace a failed file from the same row.

- Keep the “none of the above” business choice mutually exclusive in company setup and reject conflicting values before saving.

- Recover the current setup card when a generic question or invalid answer would interrupt onboarding. Accept an explicit business selection in chat and use native month controls for the handoff and opening months.

- Show company setup validation beside the affected field. Catch malformed bank details before submission and keep edited values available for correction.

- Keep an eligibility blocker in the current setup card. Focus on its single editable field, apply one confirmed correction, and preserve status reported by the official tax portal.

- Keep an incomplete document on the current card after a partial save. Open a focused correction form for the requested field and resume from the updated draft after saving.

- Cancel obsolete tax scans when switching setup methods. Verify the selected enterprise, source page and current draft before applying reviewed tax details.

- Keep the selected onboarding method in the draft so switching between manual entry and scanning preserves the current stage.

- Set up Zhangjie's company in four guided stages. Enter or recognize company documents, review the tax portal result, set the bookkeeping month and payroll arrangements, and confirm handoff to the local ledger. Resume saved drafts when reopening a conversation.
- Open the official Beijing or Zhejiang tax QR page as soon as the user confirms the region in chat. Detect enterprise login and read the visible tax details automatically after the user selects the company. Preview the results before saving them. Use an isolated Playwright browser and install Chromium on demand when Edge and Chrome are unavailable. Real enterprise account validation is pending.
- Disconnect WeChat from the connection dialog and scan a new code when reconnecting. Keep the original owner and conversation available after restart.
- Create new WeChat conversations in the DSH workspace where the owner connected WeChat. Keep older conversations in history when reconnecting from a different workspace.
- Show a short notice while Zhangjie prepares the WeChat handoff. Supply the filtered desktop dialogue and business context to the model through DSH's runtime context.
- Use the current business date for missing bank statement reminders during an open month. Check complete coverage when closing that month.
- Show the ledger, date, summary and debit and credit lines in the native posting approval. The card says what approving will post. Summarize the actual opening month and balances in the confirmation for entering opening balances.
- Provide the first WeChat reply with the fixed welcome's send status and text when available so it can continue the conversation.

- Show the current WeChat connection state in the Zhangjie header, mark sustained long-poll failures as reconnecting, and restore the connected state when polling recovers.

- Record WeChat welcome send attempts, response codes and retry stages in the local channel log. The log records whether a conversation context is present and omits credentials and message contents.

- Honor DSH Full access for confirmed ledger writes. Workspace-write uses one-time DSH approval, and WeChat uses owner confirmation.

- Ask one unresolved fact at a time. Use the current setup form for structured onboarding fields. In other Zhangjie conversations, allow one native DSH question per turn. WeChat uses text choices.
- Show submitted question-card answers in the original Zhangjie conversation on older DSH clients, including answers submitted before the plugin update.

- Read multiple PDFs referenced in the same Zhangjie message through the DSH Desktop file picker or chat composer drop. Each file is read and authorized separately.
- Honor DSH Full access when reading the current turn's PDF outside the workspace. With workspace-write permissions, DSH asks before reading the file.

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
