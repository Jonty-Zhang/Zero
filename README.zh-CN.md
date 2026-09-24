# Zero

[English](README.md)

Zero 是一个面向编程任务的本地优先执行节点。用户通过本机界面或 CLI 提交任务；Zero 将任务写入持久队列，完成路由，在独立 Git worktree 中执行，运行配置的检查，交给新的 Codex 会话审核，并归档结果。即使关闭浏览器，后台服务仍会继续工作。

Zero 是一个由 Node.js 服务、本地 React Web 界面和 CLI 组成的独立应用。服务负责任务状态和执行，界面是该服务的客户端。v1 面向 Windows 优先的单机单用户环境，默认只监听回环地址。

## 当前已实现

- 基于 SQLite 的任务队列和本地 HTTP API，任务状态包括 `pending`、`running`、`reviewing`、`revision`、`waiting`、`done` 和 `failed`。
- 使用 Codex 进行任务分配，并启动独立的只读 Codex 会话进行审核。用户可以手动固定执行 Harness、模型和思考强度中的任意字段；Codex 只会从 Zero 已验证的绑定中补全未指定字段。
- Codex、DeepSeek Harness（DSH）和 ZCode CLI 适配器。存在适配器不代表 Harness/模型组合已可用：Zero 要求先在本机验证绑定。DSH 使用 Zero 自有配置档。当前 ZCode 绑定使用 Zero 自有的隔离 CLI 配置档，不会使用 ZCode 桌面 app 中的提供方选择或凭据。
- 每个任务使用独立 Git worktree，运行配置的验证命令，限制返工次数，并归档包含执行、测试、审核和 Git 证据的报告。成功任务的分支保留在源代码仓库中；Zero 不会自动合并或推送分支。
- 对已验证的模型使用额度限制提供 `waiting` 状态、持久检查点和定时重试。外部命令中断后的恢复会暂停等待检查，不会盲目重放。

## 尚属设计或待验证的目标

- 像 ZCode + GLM 在同一个 worktree 中完成工作后，再交给 ZCode + DeepSeek 的多阶段自动执行，**尚未由 worker 实现**。阶段及版本化交接数据存储只是基础，不代表已经具备跨 Harness 自动接力能力。详见[工作区与接力设计](docs/workspace-handoff-design.md)。
- ZCode 桌面 `app-server` 会话协议接入仍在研究中。目前不能声称 Zero 已能使用用户现有桌面 GLM/DeepSeek 配置、在实时会话中锁定模型，或安全迁移原生对话上下文。
- 不会因为存在 DSH 或 ZCode 适配器就自动将其加入路由。必须先在 Zero 的隔离数据目录中创建并验证模型绑定；能否使用以及证据等级取决于本机 CLI 版本和验证结果。详见[服务端配置](src/server/README.md)。
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

CLI 还提供 `node dist/cli.js cancel <task-id>`。不带参数运行 `node dist/cli.js` 可查看全部选项。Web 界面和 CLI 共用本地服务与任务队列。

首次运行时，不会假设已有经过真实验证的模型绑定。提交任务前，请按照[服务端配置与绑定验证说明](src/server/README.md)操作。绑定验证可能会真实调用模型。不要把 API 密钥、代理凭据或其他机密放入仓库或 Zero 的模型注册表；身份验证由对应 CLI 的登录状态或进程环境提供。DSH 和 ZCode 应使用服务端说明中由 Zero 管理的隔离配置档，不要复制或编辑已有桌面配置。

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
