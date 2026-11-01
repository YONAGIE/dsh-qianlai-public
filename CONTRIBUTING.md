# 贡献指南 / Contributing

本分支已包含插件源码、财税核心复制快照与本地构建环境。欢迎源码修复、
文档修改、双语校对、使用场景建议及合成财务案例；以 README 和实际验证结果
说明可用范围，不要把产品方案或未完成需求当作已实现功能。

## 提交流程

1. 先查已有 Issue；较大改动先讨论，小的文字修正可直接 PR。
2. Fork 本仓库，从 `main` 创建任务分支，提交针对单一问题的改动。
3. 源码修改执行下方本地检查与必要运行验证；文档核对链接、Markdown 和涉及的 YAML。开 PR 说明目的、变化及实际结果。
4. 维护者审阅后合入，或说明需补充、延期和不接受的原因。

故障使用[九字段格式](docs/issue-reporting.md)。无需先跑测试套件，
未知版本可写“不知道”，附件可以没有。建议与求助可使用对应表单。

## 当前验证范围

源码检查：`pnpm install --frozen-lockfile` 后运行 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`。使用 package.json 声明的 Node 范围和 pnpm 12.3.4。Q-008 材料另运行 `node packages/dsh-qianlai/e2e/q008/run.mjs --validate`。

微信加载验证使用合成 iLink：`node --test packages/dsh-qianlai/tests/wechat-runtime.test.mjs`；隔离真实 DSH 检查：`node packages/dsh-qianlai/scripts/check-dsh-wechat.mjs <DSH CLI 路径>`。这不等于真实微信扫码、真实消息或模型验收。

遵守 docs/maintaining.md：不为本次合并启用或启动远端 CI，历史工作流仅以非工作流文件归档。本地检查、历史跨系统 CI 和收费模型结果分别记录。文档/表单核对双语、链接、YAML 与页面；涉及 UI、微信或人设逻辑的后续修改还需隔离宿主的对应运行验证。

## 财税核心与运行贡献

`packages/fintax-core` 是内部上游复制快照，目录、验证命令和来源记录已提供。
外部贡献者可提供问题、合成案例和期望结果；复制文件的修改先联系维护者，
由维护者处理内部修复、同步和 A6 对比，并在公开 Issue / PR 保留进度与贡献归属。
外部贡献者不需要内部仓库权限。复制快照和内部来源记录已保留；本次导入不重写核心逻辑。

运行验证使用独立 `DSH_HOME` 和合成数据。真实 API 模型测试有费用，不因文档检查自动启动。
不得提交密钥、真实票据、流水、账本、微信登录文件、带 token 的 URL 或私人聊天记录。

## 审阅与许可

初期维护者为 [@peyton-v5](https://github.com/peyton-v5)。通过任务分支和 PR 合并，
相关本地检查与完整差异审阅是当前合并依据；不承诺回复时限，不把未运行的 CI 声称为成功。
贡献沿用 Apache-2.0，不要求版权转让或额外 CLA。
遵守[行为规范](CODE_OF_CONDUCT.md)，安全问题走[私密报告](SECURITY.md)。

## English

This branch includes source packages and a local build environment. Fork and branch from main, make focused changes, use synthetic data, report actual validation, and discuss large changes first. Use the public issue numbers/severity rules and existing PR template.

Run the frozen-lockfile install, build, typecheck, lint and test locally; validate the Q-008 kit offline separately. Compiled WeChat and isolated DSH/mock-iLink checks are not real WeChat/model acceptance. Hosted CI is not enabled under docs/maintaining.md; archived historical workflow/results are provenance only.

Do not hand-edit copied fintax-core logic: contact maintainers for upstream repair, synchronization and A6 comparison. External contributors need no internal access. Use an isolated DSH_HOME; paid model tests are explicit and separate. No credentials, private chats or real financial data. Contributions use Apache-2.0 without copyright assignment or additional CLA; artwork restrictions are retained.
