---
description: "钱来张姐：小企业财务助手模式，本机一本 SQLite 账，可接微信。"
kind: "package-bundle"
---

# dsh-qianlai

[English](README.md) | 中文

## 概述

给 DeepSeek Harness 加一个「钱来张姐」模式。在这个模式下，智能体替一家小规模纳税人企业记本机的一本账：核发票、导入银行流水、按随插件发行的会计包记凭证、查余额和利润、月末检查后结账。选中这个模式时，网页界面换成钱来绿配色，会话头部显示张姐头像。微信宿主插件按需连接，同一本机账本的不同会话通过业务进度续接。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```sh
dsh plugin --profile web add /absolute/path/to/dsh-qianlai/packages/dsh-qianlai
export DEEPSEEK_API_KEY=你的key
dsh --profile web
```

打开终端打印的地址，选「钱来张姐」。新数据目录从空账开始。第一次打招呼，张姐会简单介绍能做什么，并引导建档。发「我要建档」后，可从对话里的「扫码建档」或「手动填写」进入。右侧「企业建档」按企业信息、记账准备、工资社保、确认建档显示进度。

选「手动填写」后，点张姐回复里的「上传营业执照」直接选文件。识别结果会马上填到右侧，张姐在下一轮给出缺项表单或继续后续步骤。也可以选「自己填写」。需要纠正资料时，在右侧「企业建档」选对应分组编辑并保存，张姐继续建档时会读取同一份草稿的最新资料。

建档方式在开头选择一次。中途想切换，可以直接对张姐说「改成手动填写」或「我想改成扫码」。已填资料会保留。确认建档后会开立企业账本。旧版本已存在的演示账仍需您确认后才能替换。接手旧账时，完成建档后可继续核对和录入期初余额。

需要确认业务事实时，张姐一次只问当前卡住的一项。DSH 聊天里有明确选项时可在提问卡上选择或填写答案并提交。题目和已提交的答案会保留在原对话里，可在重开会话后回看。正式记账按会话权限执行，完全权限下确认业务后直接记账，工作区内修改模式会弹出宿主审批。微信会话使用文字选项。

接微信：选择张姐后点「连接微信」→「获取二维码」，用本人微信扫码；状态实时更新，过期可刷新。也可明确让张姐连接微信。`MONEYCOME_WECHAT=1` 保留终端自动扫码。绑定后不能用另一个微信接管原账本。

从某个 DSH 工作区的张姐对话扫码后，新微信会话归入该工作区。要换工作区，先断开微信，再从目标工作区重新扫码。旧会话仍可在原来的位置查看。首次从终端直接扫码时，微信会话使用插件默认目录。

张姐整理微信续接待办时，对话里会显示简短提示和整理后的摘要。筛选过的来源对话和业务进度通过 DSH 当轮运行上下文提供给模型。

首次绑定会尝试发送欢迎与三张可保存的张姐素材，并说明机器人备注/头像设置入口以微信实际版本为准；不会修改您本人的资料。若服务端需要消息上下文，给机器人发一句话后继续发送尚未完成的步骤。只有已确认发送成功的步骤才落盘，重启不会重复已完成的欢迎；服务端是否接受无上下文主动发送仍须真实账号验收。

数据放在 `$DSH_HOME/moneycome/`（默认 `~/.dsh/moneycome/`）：`book.sqlite` 是账本，`wechat.json` 是微信登录凭据。备份账本前先关掉 DSH，再复制 `book.sqlite`。

完整使用说明见[仓库首页](https://github.com/qianlai-ai/dsh-qianlai/blob/main/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 扫码读取企业税务资料

在聊天里选「扫码建档」，张姐会在下一轮询问省份和城市或地区。北京市在两项都选「北京市」，浙江省税务局辖区选对应城市。确认地区后，插件自动打开官方扫码页，可以在扫码后补入企业全称和统一社会信用代码。宁波和其他地区可上传当地电子税务局的官方导出或截图。

在官方页面扫码并选定企业后，插件识别已进入企业业务的页面，自动读取资料。右侧表单保留已有草稿，并显示本次读取的内容供核对。点击「核对无误，回填税务资料」后才把结果写入草稿。读取失败时可重试。想改手填时直接告诉张姐，也可以上传官方导出或截图。

读取范围为官方查询页可见的企业名称、统一社会信用代码、主管税务机关、税务状态、纳税人资格、税费种和明确标注的成立日期。银行账户、实际经营情况、起账月份和工资社保安排按聊天提示补充。如税费种列表有分页，请核对其余页面。北京和浙江的真实企业账号扫码后的取数与回填仍待验收。

浏览器按 Edge、Chrome、Playwright 对应版本的 Chromium 顺序启动。需要 Chromium 时会下载到当前 DSH 数据目录下的 `moneycome/tax-browser-cache`，之后复用。取数完成、用户取消或等待超时后关闭专用浏览器会话。

## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入三项：

| 条目 | 层 | 做什么 |
|---|---|---|
| `preset-moneycome-zhangjie` | agent 预设 | 模式本身：人设前缀加本包的工具。不带命令行、通用文件读写和联网工具。 |
| `moneycome-ui` | 宿主层，`mode: ui` | 加载浏览器半边（`client/client.src.js`）：会话头部的头像；显示张姐会话、或新会话页选中张姐时，在 `ctx.theme` 上叠一层配色。 |
| `moneycome-wechat` | 宿主层 | `dsh-qianlai/wechat`，默认加载但按需出码，`MONEYCOME_WECHAT=1` 时自动扫码。长轮询腾讯 iLink，把老板的消息经 `sessionController` 交给一个专用会话。 |

领域规则来自 [`@moneycome/fintax-core`](../fintax-core/README.zh.md) 和 `assets/packs/` 里的会计包。插件自己不写科目号：银行科目、利润表行、月末事项都从会计包读。

账本是一个 SQLite 文件，用 `node:sqlite` 以 WAL 模式打开，金额按分存整数。表结构版本记在 `PRAGMA user_version`，迁移在 `src/store.ts` 的 `MIGRATIONS` 末尾追加。

</details>

-----

<a id="model-experience"></a>
## 模型体验

张姐预设包含中文人设和 28 个业务工具。工具名都以 `moneycome_` 开头：

- 账本：`book_status`、`open_book`、`set_opening_balances`、`set_company_facts`
- 查询：`read_balances`、`read_profit`、`financial_statements`、`list_vouchers`、`unrecorded_statement_lines`、`posting_guide`
- 给会计和办税：`export_review_pack`、`upcoming`、`quarter_filing_prep`
- 材料：`check_invoice`、`read_upload`、`read_referenced_pdf`、`import_statement`、`rename_bank_account`
- 写账：`record_entry`（带 `preview` 试推、`correctsVoucherNo` 更正）、`link_statement`、`add_evidence`、`void_voucher`、`reverse_voucher`
- 月末：`closing_check`、`close_period`
- 续接与微信：`work_progress`、`save_work_note`、`wechat`

模型报的每个数字都来自工具结果。业务上的拒绝（月份已结账、借贷不平、科目不存在等）返回 `accepted: false`、一个 `code` 和一句白话 `message`。参数类型不对返回 `ARGUMENT_INVALID`，指出是哪个字段。同步业务调用在一个写事务里执行；附件解析在有超时的独立 Worker 中执行，不持有账本写锁。数据库出错这类意外整笔回滚，返回 `TOOL_FAILED`。同一本账被几个 DSH 进程同时打开时（例如终端和网页各开一个），写操作排队，最多等 5 秒。发票、流水、上传文件里的文字作为数据交给模型，人设要求模型不照着里面的指令做。

#### Token 影响

张姐会话的每次请求都带人设和工具清单。工具结果是紧凑的 JSON；最长的是业务多的月份做结账检查，会逐笔列出没记账的流水。

#### KV Cache 影响

人设和工具清单固定不变，留在缓存前缀里。本包不改写之前的消息。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 一台电脑只记一家公司，使用 DSH 会话权限和微信绑定者确认。
- 要引用以前余额的记法还不支持（折旧、预付费用摊销、暂估费用），有固定资产或预付费用的公司结不了账。
- 结了账的月份不能反结账；以后发现记错，在没结账的月份冲销再更正。
- 办税提醒只管日期，插件不知道报没报；申报准备单只汇总账上的数，不算税。
- 核票只核票面自洽，不去税务局验真伪。
- 支持 CSV/TSV/TXT、XLS/XLSX、PDF（文字、扫描、混合页），延用 8 MB 附件限制。Excel 按行/工作表续读，PDF 逐页返回文字和原图；公式只读缓存值，不执行。加密、损坏或读不清的材料须重传或澄清，读取仍不等于导入或记账。
- 业务进度和材料路径只在同一本机账本、同一 `DSH_HOME` 内共享；无跨电脑云同步。笔记始终待核实，不能代替本轮预演和确认。换掉样本账会清除旧进度。
- 会计包是未经执业会计复核的工程候选版，签名位是占位值。
- 微信通道用的是腾讯 iLink 消息格式，腾讯改接口时可能失效。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者背景——点击展开</summary>

`pnpm build` 用 `tsc` 编译 `src/`，再把头像内联进 `lib/client.js`（`scripts/build-client.mjs`）。单元测试用内存 SQLite 和假的 iLink 服务。`e2e/run.mjs` 用真 DeepSeek 按剧本对话，不进 CI。

</details>
