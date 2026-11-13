# 钱来张姐 · dsh-qianlai

[English](README.md)

面向小企业的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 财务助手插件。

**当前状态：源码接入候选，尚未发布 npm 包或 Release。** 本次从既有维护版本 `dad68cf856fae0bb2bb2ea954f6e9400a0e69098` 导入最新代码、已合入修复和筛查后的测试材料；接入前后差异与验证边界见 [迁移记录](docs/history/migration.md)。

## 功能与范围

- 单机、单企业 SQLite 账本，首次启动提供合成样本账。
- 发票自洽校验、银行流水导入、期初余额、凭证试算与确认记账。
- 余额、利润、简表、结账检查与结账、作废和冲销、会计复核 CSV 导出。
- 微信 iLink 通道提供扫码入口、状态与刷新；与桌面/网页共享同一本机账本的业务记录、材料引用和待核实笔记。
- 直接读取 XLS/XLSX，以及 PDF 的文字层和逐页原图；扫描与混合页仍需模型核对，不会自动记账。
- 首次绑定会尝试发送欢迎和三张张姐素材，记录发送进度；真实微信送达与模型回归边界见 [本次验证记录](docs/validation/open-issues-2026-11-01.md)。

功能细节与限制见 [插件说明](packages/dsh-qianlai/README.zh.md)。AI 回复须经工具与账本事实核实，不能替代会计，不提供税务申报或付款执行。发送模型的对话和上传材料会经过相应模型/微信服务；账本本体存放在本机。

## 从源码构建与验证

需要 Node.js 22.19 以上的 22.x 或 24 以上，以及项目声明的 pnpm 12.3.4。不是所有 22.19 之后的非 LTS 主版本都在支持范围内。

```sh
git clone https://github.com/qianlai-ai/dsh-qianlai.git
cd dsh-qianlai
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
node packages/dsh-qianlai/e2e/q008/run.mjs --validate
```

在已有 DSH 中安装时，指定**构建后的子目录** `packages/dsh-qianlai` 的绝对路径，不是仓库根目录。桌面插件页可填写该路径；CLI 示例：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-qianlai/packages/dsh-qianlai
```

Windows 示例路径：`D:\work\dsh-qianlai\packages\dsh-qianlai`。使用独立 `DSH_HOME`，避免测试影响日常数据与登录配置。当前源码使用 workspace 财税核心依赖，分发包的依赖发布与安装仍须单独验收；本次不提供未经核实的 npm 安装命令。

在 DSH 桌面版的钱来张姐会话里，用输入框的「文件」选择一份 PDF，或直接拖到聊天框，再发送消息。每轮可读一份不超过 8 MB 的 PDF。「完全权限」下可直接读取本轮引用的工作区外 PDF。「工作区内修改」下，工作区外的 PDF 需在 DSH 确认本次读取。

本地检查分发产物可运行 `pnpm pack:all`：先构建两包，再使用 pnpm 原生递归打包，在仓库根 `dist/` 生成 `moneycome-fintax-core-0.1.0.tgz` 和 `dsh-qianlai-0.1.0.tgz`。插件包依赖对应版本财税核心；本地使用这些归档时须将该依赖解析到配套核心归档（如使用包管理器 override）。此命令不发布 npm，也不代表注册表安装已可用。

随后运行 `pnpm test:packages`，会在新临时消费者中安装归档并配置核心 override，保留 pnpm 默认供应链保护，核对工具加载、中文 XLS/XLSX 与 CSV 读取、微信导出入口，以及附带 SheetJS/许可证的字节一致性。测试可能获取公开依赖和元数据，关闭安装生命周期脚本，不使用真实模型或账号，完成后清理消费者目录。SheetJS CE 沿用官方 0.20.3，改为构建时附带，避免 URL 运行时子依赖阻断安装。

## 微信与真模型测试

选择「钱来张姐」后点「连接微信」，会按需获取二维码并用本人微信确认；已经连接时保留当前登录，不要求重复扫码。页面显示扫码、过期、已连接等真实状态，可直接刷新。`MONEYCOME_WECHAT=1` 保留终端启动时自动出码。不要提交登录文件。首次绑定或旧版升级后尚未完成欢迎时，会尝试发送使用介绍、机器人备注/头像说明和三张素材；若服务端需要入站消息的 context token，先发一句“你好”后续发。已完成的欢迎不会因重启重发。

从张姐会话点「连接微信」，或让张姐通过工具连接微信时，会绑定该来源会话，结合有限的最近可见对话和当前账本记录，由现有张姐 Agent 主动整理正在处理的财务事项并邀请继续。即使只有查询计划、还没有写入业务记录，也能续接；同一会话进度不会反复推送，普通状态轮询不触发摘要。只谈扫码而没有财务事项时不编造任务。摘要轮只读，不开账、记账、导入或修改企业事实，后续实际操作仍需老板明确提出并按原生批准流程确认。不会读取其他预设会话、系统提示或模型推理；没有新增发送结果界面。独立数据目录/不同电脑不因此同步。

通道失败时保留未确认的收取游标，并使用消息 ID 和 DSH 请求身份去重。未确认发送的回复片段保存在私有 `moneycome/wechat.json` 中，联网后自动重试，重启可续发；该文件包含登录凭据及待发业务回复，不能作为公开附件。成功片段会从待发队列移除。此机制不保证网络服务端的最终去重，也不能恢复尚未来得及保存的回复，不应据此重新执行业务。

微信单条媒体收取上限为20 MB，超限会提示压缩或拆分。文档解析仍采用现有8 MB上限；收到文件不等于已完成解析或记账。

开账、期初余额、正式记账、作废、冲销和结账需要 DSH 原生批准；遵循宿主的批准配置，缺少服务或应答能力时拒绝执行。查询和分录预演不需要批准。桌面/网页使用宿主批准交互；微信会发出本次操作明细和五分钟有效的随机确认码，只有绑定老板的对应回复才能应答，取消、超时和重启后旧码失效。确认消息不交给模型。等待批准期间账本变化会要求重新核对，同次宿主调用重试返回原执行回执；不同调用即使日期和金额相同也需要各自批准，不会按业务文字误去重。

真模型回归先用 `node packages/dsh-qianlai/e2e/run.mjs --list` 查看场景。模型密钥只通过 `DEEPSEEK_API_KEY` 环境变量提供。Windows 可设 `DSH_ENTRY` 为已安装 DSH 的 `lib/bin.js` 绝对路径，驱动会使用当前 Node；如需选择 Node 可设 `DSH_BIN`。`ZSTD_BIN` 可指定 zstd 可执行程序，日志通过 stdin 解压以兼容中文路径。

微信二维码能力回归运行 `node packages/dsh-qianlai/e2e/run.mjs wechat-qr-`；仍使用真实 DSH/模型，但 iLink 是明确隔离的合成网络，不申请真实微信账号。覆盖普通二维码请求、引用旧能力说明后的再次请求及已连接控制。可设 `E2E_REPEAT=3` 重复，`E2E_PORT=0` 由系统分配空闲端口；每次选择新的 `E2E_OUT`。它不改写旧聊天，也不代替真人扫码验收。

无人值守合成测试须显式设 `E2E_APPROVAL_MODE=allow` 后运行 `native-approval-flow`，或设为 `reject` 后运行 `native-approval-rejection`。驱动只在全新测试数据目录加载临时应答器，记录真实宿主批准结果；该应答器不在生产配置中，也不代替真人微信或桌面批准验收。其他含财务写入的自动场景也可显式选择批准模式；不设时沿用宿主交互，可能等待应答。每次使用新的 `E2E_OUT`，禁止复用已含数据的场景 home。测试会产生模型费用。

微信原生确认的真模型检查：构建后设置 `DEEPSEEK_API_KEY`、`DSH_ENTRY` 和独立临时目录，再执行 `node packages/dsh-qianlai/e2e/check-wechat-approval.mjs`。它运行真实 DSH 和模型，仅将 iLink 替换为合成网络，依次验证预演、原生批准请求、老板随机码、一次正式入账和回复；不加载自动批准应答器，不使用真实微信账号，完成后清理自有测试 home。真人扫码与服务器实际送达仍需单独验收。

欢迎与桌面续接的真模型检查：同样设置自己的环境变量 key、`DSH_ENTRY`、`ZSTD_BIN`，执行 `node packages/dsh-qianlai/e2e/check-wechat-onboarding.mjs`；`E2E_REPEAT=2` 可各重复两次。真实 DSH/模型下，合成 iLink 分别模拟直接允许发送、要求先有入站上下文，检查欢迎与三张图、来源会话的主动消息、账本不变和重启去重。脚本输出桌面对话和微信可见回复供人工复核实际进度和继续邀请，不能只用关键词判定语义通过；`E2E_OUT` 可保存合成结果。该检查不证明腾讯服务端接受没有 context token 的首次发送，也不代替真人微信验收。

跨端接续限同一本机账本、同一 `DSH_HOME`；独立电脑或独立 Home 不自动同步。笔记不是已确认事实，更不是下一轮的记账授权。切换样本账时，旧业务进度一并清除。

[Q-008 复现材料](packages/dsh-qianlai/e2e/q008/README.md)包含固定场景、异常回复与三版人设。离线校验无需 Key；真模型测试另行显式启动，使用测试者自己的 `DEEPSEEK_API_KEY` 环境变量，会产生费用。无须提供内部仓库或原作者的凭据。

## 协作、许可和状态

[主体业务回归计划与本轮结果](docs/validation/business-regression.zh.md)涵盖建账、记账、对账、结账、季度准备、跨年恢复与微信。主流程可用合成账本复跑并核对报表金额。

- [问题反馈](https://github.com/qianlai-ai/dsh-qianlai/issues/new/choose)、[讨论](https://github.com/qianlai-ai/dsh-qianlai/discussions)、[贡献指南](CONTRIBUTING.md)、[九字段规范](docs/issue-reporting.md)。
- [原五个 PR 的修复和验证记录](docs/history/legacy-prs.md)、[来源与隐私审查](docs/history/import-review.json)。历史验证与本次验证分别标注，不能将历史 CI 当作本库 CI。
- 按当前维护规则，本次不启用远端 CI。原配置以非工作流文件归档，构建和运行检查在本地执行。
- 项目由 qianlai-ai 社区维护，初期维护者见 [MAINTAINERS.md](MAINTAINERS.md)；不代表 DeepSeek 官方。
- 代码按 [Apache-2.0](LICENSE) 提供；张姐图片只限随插件展示，见 [NOTICE](NOTICE) 和 [素材声明](packages/dsh-qianlai/assets/zhangjie/NOTICE.md)。
- 仅提交合成数据和最小脱敏证据，安全问题按 [SECURITY.md](SECURITY.md) 私密报告。
