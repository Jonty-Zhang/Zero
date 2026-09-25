# Zero

[English](README.md)

Zero 是一个面向编程任务的本地优先执行节点。用户通过本机界面或 CLI 提交任务；Zero 将任务写入持久队列，完成路由，在独立 Git worktree 中执行，运行配置的检查，交给新的 Codex 会话审核，并归档结果。即使关闭浏览器，后台服务仍会继续工作。

Zero 是一个由 Node.js 服务、本地 React Web 界面和 CLI 组成的独立应用。服务负责任务状态和执行，界面是该服务的客户端。v1 面向 Windows 优先的单机单用户环境，默认只监听回环地址。

## 当前已实现

- 基于 SQLite 的任务队列和本地 HTTP API，任务状态包括 `pending`、`running`、`reviewing`、`revision`、`waiting`、`recovery_required`、`done` 和 `failed`。
- 使用 Codex 进行任务分配，并启动独立的只读 Codex 会话进行审核。用户可以手动固定执行 Harness、模型和思考强度中的任意字段；Codex 只会从 Zero 已验证的绑定中补全未指定字段。
- Codex、DeepSeek Harness（DSH）和 ZCode 适配器。存在适配器不代表 Harness/模型组合已可用于路由：Zero 要求先验证绑定。DSH 和隔离式 ZCode CLI 绑定使用 Zero 自有配置档。现有桌面 ZCode `app-server` 适配器及 `verify-binding zcode-desktop` 流程已通过 mock 测试；实时接入尚未成功，因此该路由尚未验证，也不会用于任务路由。验证边界见[服务端配置](src/server/README.md)。
- 每个任务使用独立 Git worktree，运行配置的验证命令，限制返工次数，并归档包含执行、测试、审核和 Git 证据的报告。成功任务的分支保留在源代码仓库中；Zero 不会自动合并或推送分支。
- 有序 `executionStages` 已通过核心、HTTP API 和 CLI 的 `--stages-file` 选项实现，会在同一个任务 worktree 中串行执行。每个阶段会记录关联尝试、工作树指纹，以及由 Zero 实测事实构成的版本化交接单；报告收录这些阶段记录。
- 对已验证的模型使用额度限制提供 `waiting` 状态、持久检查点和定时重试。额度恢复已通过 mock 测试，包括服务重启后的恢复；尚未观察到真实提供方额度限制事件。普通崩溃发生时，Zero 会定期将租约过期的活动任务转为 `recovery_required`，保存租约及被中断尝试/阶段的证据。租约过期不能证明旧进程已停止，因此不会自动重试；请先检查 worker 进程和任务 worktree，再决定如何继续。
- 崩溃恢复的当前边界和后续设计见[崩溃恢复设计](docs/crash-recovery-design.md)。
- 原生 Windows 进程 guardian 已在 CI 中通过构建和进程包含测试；目标机器部署及启动测试仍未验证。详见 [Windows 部署](docs/windows-deployment.md)。

## 尚属设计或待验证的目标

- ZCode 桌面实时接入仍未验证。本机 app-server 探测尚未返回可用模型目录，也没有建立基于 nonce 的绑定；因此不能据此声称桌面 GLM 或 DeepSeek 模型已加入路由。适配器不会声称已确认实际响应模型身份，也不会迁移桌面会话上下文。详见[接入设计](docs/zcode-existing-desktop-enrollment.md)。
- DSH 和隔离式 ZCode CLI 不会仅因适配器存在就加入路由。必须先在 Zero 隔离的数据目录中创建并验证绑定；可用性和证据等级取决于本机 CLI 版本及验证结果。详见[服务端配置](src/server/README.md)。
- 当前审核使用新的 Codex 会话，但不保证审核模型一定不同于执行模型：当执行 Harness 也是 Codex 时，模型层面的独立性取决于审核绑定配置。

更完整的目标架构、上游项目比较和许可证核查见 [Zero v1 方案](docs/zero-v1-proposal.md)。Zero 是原创代码，并非对所研究项目的 fork；项目采用 [Apache-2.0 许可证](LICENSE)。

## 从源码安装和运行

需要 Node.js 24 或更新版本、Git，以及已登录的 Codex CLI。在仓库根目录执行：

```powershell
npm ci
npm --prefix web ci
npm run build
npm --prefix web run build
node dist/cli.js serve
```

打开 <http://127.0.0.1:4179>。服务独立于浏览器运行。也可以在另一个终端通过 CLI 提交任务：

```powershell
node dist/cli.js submit --repo 'C:\path\to\repo' --prompt '修复解析器问题' --check 'npm test'
node dist/cli.js status
```

如需提交有序的执行阶段选择，可通过 `--stages-file` 指定 JSON 数组。每个阶段可按需设置 `harnessId`、`modelId` 和 `reasoningEffort`；未指定的字段仍由 Codex 分配器补全。现有的 `--harness`、`--model` 和 `--effort` 选项会设置任务级默认值，阶段中单独指定的字段可以覆盖默认值。每个阶段的最终选择都必须匹配当前可用且已在本机验证的绑定。

```json
[
  { "harnessId": "<first-harness-id>", "modelId": "<first-model-id>" },
  { "harnessId": "<second-harness-id>", "modelId": "<second-model-id>", "reasoningEffort": "high" }
]
```

请将示例 ID 替换为已验证绑定的 ID，将内容保存为 `stages.json`，然后运行 `node dist/cli.js submit --repo 'C:\path\to\repo' --prompt '实现此改动' --stages-file stages.json`。API 会根据当前可用且已验证的绑定检查每个阶段的最终选择，并按提交顺序保存。

CLI 还提供 `node dist/cli.js cancel <task-id>`。不带参数运行 `node dist/cli.js` 可查看全部选项。Web 界面和 CLI 共用本地服务与任务队列。

首次运行时，不会假设已有经过真实验证的模型绑定。提交任务前，请按照[服务端配置与绑定验证说明](src/server/README.md)操作。绑定验证可能会真实调用模型。不要把 API 密钥、代理凭据或其他机密放入仓库或 Zero 的模型注册表；身份验证由对应 CLI 的登录状态或进程环境提供。DSH 和隔离式 ZCode CLI 绑定使用服务端说明中由 Zero 管理的配置档。单独的 ZCode 现有桌面接入路径使用 app-server 会话，不复制或编辑桌面配置。

## 运行数据与隐私

默认情况下，Zero 将 SQLite 数据库、本地配置、worktree、日志、验证记录和报告保存在源码目录之外：Windows 使用 `%LOCALAPPDATA%/Zero`，其他平台使用 `~/.local/share/zero`。开发时可将 `ZERO_DATA_DIR` 指向源码目录中的位置；`data/.zero/` 已被 Git 忽略。请保护此数据目录，其中的任务提示、diff、命令输出和报告可能包含项目敏感信息。

HTTP 服务默认绑定 `127.0.0.1:4179`，v1 不支持远程绑定。Git worktree 可以将任务改动与主工作区分开，但它**不是操作系统安全沙箱**。无人值守任务应使用权限较低、只能访问指定仓库和凭据的账户运行。验证命令以子进程运行，应视为代码执行。

## 架构

```text
Web 界面 / CLI
       │ 本地 HTTP API
       ▼
SQLite 队列 ── Scheduler / 租约 ── Codex 分配器
                                     │
                                已验证的路由选择
                                     ▼
                                  Git worktree
                                     │
                            Harness 适配器 → 执行
                                     │
                              配置的检查 / 测试
                                     │
                            新的只读 Codex 审核
                               │            │
                             返工           通过
                               └──有限重试──┘
                                     │
                                报告和任务分支
```

SQLite 是任务状态的权威来源。Zero 记录尝试和证据、运行配置的检查，并决定任务是否可以进入 `done`；Agent 自己报告完成并不足以通过门禁。详细目标架构与当前差距见 [v1 方案](docs/zero-v1-proposal.md)和[路由与审核契约](docs/route-review-contract.md)。

## 项目文档

- [Zero v1 方案、上游项目比较和许可证](docs/zero-v1-proposal.md)
- [工作区与跨 Harness 接力设计](docs/workspace-handoff-design.md)
- [路由与审核契约](docs/route-review-contract.md)
- [本地服务配置与绑定验证](src/server/README.md)
- [Windows 无人值守部署](docs/windows-deployment.md)
- [Super Plumber 评估](docs/super-plumber-assessment.md)
- [真实任务验证记录](docs/live-validation.md)
