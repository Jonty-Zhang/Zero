# Zero

[English](README.md)

Zero 是一个面向编程任务的本地优先执行节点。用户通过本机界面或 CLI 提交任务；Zero 将任务写入持久队列，完成路由，在独立 Git worktree 中执行，运行配置的检查，交给新的 Codex 会话审核，并归档结果。即使关闭浏览器，后台服务仍会继续工作。

Zero 是一个由 Node.js 服务、本地 React Web 界面和 CLI 组成的独立应用。服务负责任务状态和执行，界面是该服务的客户端。v1 面向 Windows 优先的单机单用户环境，默认只监听回环地址。

## 当前已实现

- 基于 SQLite 的任务队列和本地 HTTP API，任务状态包括 `pending`、`running`、`reviewing`、`revision`、`waiting`、`recovery_required`、`done` 和 `failed`。
- 主分配器可切换为 Codex 订阅或兼容 OpenAI API 的 HTTPS 模型，负责选择路由和执行 Harness；分配器本身不会实现任务。用户可以手动固定 Harness、模型和思考强度中的任意字段；所选分配器只会从 Zero 已验证的绑定中补全未指定字段。结果仍由独立的只读 Codex 会话审核。
- API 分配器在 Web 界面中配置：`baseUrl` 必须是 HTTPS 地址，`model` 是分配器模型，`keyEnv` 是 Zero 服务进程可读取的环境变量名称。Zero 只保存变量名，不保存 API 密钥；密钥由 Zero 服务进程环境提供。Codex Reviewer 保持不变。
- Codex、DeepSeek Harness（DSH）和 ZCode 适配器。存在适配器不代表 Harness/模型组合已可用于路由：Zero 要求先验证绑定。DSH 和隔离式 ZCode CLI 绑定使用 Zero 自有配置档。现有桌面 ZCode `app-server` 适配器及 `verify-binding zcode-desktop` 流程已通过 mock 测试；实时接入尚未成功，因此该路由尚未验证，也不会用于任务路由。验证边界见[服务端配置](src/server/README.md)。
- 每个任务使用独立 Git worktree，运行配置的验证命令，限制返工次数，并归档包含执行、测试、审核和 Git 证据的报告。成功任务的分支保留在源代码仓库中；Zero 不会自动合并或推送分支。
- 有序 `executionStages` 已通过核心、HTTP API 和 CLI 的 `--stages-file` 选项实现，会在同一个任务 worktree 中串行执行。每个阶段会记录关联尝试、工作树指纹，以及由 Zero 实测事实构成的版本化交接单；报告收录这些阶段记录。
- 可持久保存并按序执行多个任务步骤，可通过 Web 界面或 API 提交，并用 CLI 查询。每一步都是普通任务，可分别手动指定 Harness、模型和思考强度；留空字段由当前分配器从已验证绑定中选择。同一仓库中的步骤会在前一步达到 `done`、并具有权威应用提交和完整报告后，从该步骤的已验证结果提交开始。
- 序列状态会区分步骤执行和整体目标验收。所有步骤任务完成后，如果提供了整体目标或目标级验收标准，Zero 会运行独立的汇总 Codex 验收。HTTP API 和界面会展示最近一次验收的状态、判定（`PASS`、`changes_requested` 或 `blocked`）、摘要、发现和额度重试时间。`steps_completed` 表示尚无可用的汇总判定；`completed` 表示未提供目标级信息，或汇总验收返回 `PASS`。实现已有自动化测试覆盖，但尚未验证真实目标验收流程；根据发现自动执行目标级返工的功能尚未实现。
- 对已验证的模型使用额度限制提供 `waiting` 状态、持久检查点和跨服务重启的定时重试。自动化测试覆盖分配、执行、审核和审核要求返工期间的额度续跑；尚未观察到真实提供方的额度限制事件。普通崩溃时，Zero 先隔离过期租约。原生 guardian 证明上一代进程 Job 已清空后，合格任务可在已登记的同一 worktree 中恢复：首次执行、已封存审核包的审核与提交/报告，以及审核要求的返工。恢复的执行和返工会重新路由、建立新的尝试、重跑检查和审核。恢复必须匹配任务代际、Git 身份、允许修改路径、审核包及结论、返工次数等证据；证据缺失或不符时任务保留在 `recovery_required` 等待检查。
- 恢复实现已包含自动化测试；但无人值守安装、重启恢复、真实 Harness 执行、真实提供方额度恢复，以及目标电脑上的崩溃故障注入尚未验收。忽略的构建/缓存文件不包含在 Zero 基于 Git 的 worktree 指纹中；它们可能留在 worktree 并影响恢复后的命令，因此应使用可重复的检查，不要依赖隐藏的本地缓存状态。详见[崩溃恢复设计](docs/crash-recovery-design.md)和[恢复实现边界](docs/crash-recovery-next-slice.md)。
- 创建 worktree 前会持久记录目标仓库、分支、路径和基点；`git worktree add` 成功后再记录实测身份与指纹。创建结果不确定时保留这些证据并等待检查。
- 原生 Windows 进程 guardian 已在 CI 中通过构建和进程包含测试；目标机器部署及启动测试仍未验证。详见 [Windows 部署](docs/windows-deployment.md)。
- Windows 发布目录脚本可打包已构建的服务、界面、CLI、显式指定的 Node 运行时与 guardian，并生成文件哈希清单。独立校验器在 CI 中核对所有文件并启动包内 CLI。未签名 NSIS 安装包已在 GitHub Windows runner 上通过安装/卸载冒烟测试，详见 [Windows 单应用安装包](docs/windows-app-packaging.md)；目标电脑上的安装和无人值守运行仍未验收。

## 尚属设计或待验证的目标

- ZCode 桌面实时接入仍未验证。本机 app-server 探测尚未返回可用模型目录，也没有建立基于 nonce 的绑定；因此不能据此声称桌面 GLM 或 DeepSeek 模型已加入路由。适配器不会声称已确认实际响应模型身份，也不会迁移桌面会话上下文。详见[接入设计](docs/zcode-existing-desktop-enrollment.md)。
- DSH 和隔离式 ZCode CLI 不会仅因适配器存在就加入路由。必须先在 Zero 隔离的数据目录中创建并验证绑定；可用性和证据等级取决于本机 CLI 版本及验证结果。详见[服务端配置](src/server/README.md)。
- 当前审核使用新的 Codex 会话，但不保证审核模型一定不同于执行模型：当执行 Harness 也是 Codex 时，模型层面的独立性取决于审核绑定配置。

更完整的目标架构、上游项目比较和许可证核查见 [Zero v1 方案](docs/zero-v1-proposal.md)及后续的 [Herdr 生态评估](docs/herdr-assessment.md)。Zero 是原创代码，并非对所研究项目的 fork；项目采用 [Apache-2.0 许可证](LICENSE)。

## 从源码安装和运行

需要 Node.js 24 或更新版本、Git，以及已登录的 Codex CLI（始终用于 Codex Reviewer）。使用 API 分配器时，Zero 服务进程还需能通过 HTTPS 访问所配置的兼容 API，并读取密钥环境变量。在仓库根目录执行：

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

### 有序任务序列

使用 `submit-sequence` 提交包含至少两个有序任务的 JSON 文件；使用 `sequences` 查看序列列表，使用 `sequence <sequence-id>` 查看单个序列：

```powershell
node dist/cli.js submit-sequence --file sequence.json
node dist/cli.js sequences
node dist/cli.js sequence <sequence-id>
```

每个任务条目使用与 `submit` 相同的字段：`repoPath`、`baseRef`、`prompt`、可选的 `acceptanceCriteria`、`checkCommands`、`maxRevisions` 和可选的 `execution`。每一步都要重复填写仓库和基础 Ref。手动执行选择放在 `execution.harnessId`、`execution.modelId` 和 `execution.reasoningEffort`；省略或留空的字段由当前分配器从已验证绑定中选择。

```json
{
  "objective": "为应用添加账户恢复功能",
  "acceptanceCriteria": ["用户可以申请恢复", "恢复链接会安全过期"],
  "maxGoalRevisions": 2,
  "tasks": [
    {
      "repoPath": "ABSOLUTE_PATH_TO_GIT_REPOSITORY",
      "baseRef": "main",
      "prompt": "添加账户恢复请求接口和测试",
      "acceptanceCriteria": "接口拒绝无效请求",
      "checkCommands": ["npm test"],
      "maxRevisions": 2,
      "execution": { "harnessId": "<verified-harness-id>", "modelId": "<verified-model-id>", "reasoningEffort": "<verified-effort>" }
    },
    {
      "repoPath": "ABSOLUTE_PATH_TO_GIT_REPOSITORY",
      "baseRef": "main",
      "prompt": "添加恢复表单和过期链接处理",
      "acceptanceCriteria": "过期链接会显示明确错误",
      "checkCommands": ["npm test"],
      "maxRevisions": 2
    }
  ]
}
```

请将仓库路径和绑定占位符替换为实际值。手动指定的 Harness、模型和思考强度组合必须当前可用并已验证；步骤按文件中的顺序保存。同一仓库中的后续步骤从前一步的已验证结果提交开始。提供整体目标信息时，所有步骤完成后 Zero 会运行汇总 Codex 验收，并在序列 API 和界面中展示当前状态与结果。验收 `PASS` 后状态为 `completed`；`changes_requested` 可触发自动追加的整体目标返工任务，最多为 `maxGoalRevisions` 次（默认 `2`，允许范围 `0`–`5`），`goalRevisionCount` 展示已使用次数。返工上限用尽仍未通过时，序列保持阻塞并显示原因；`blocked` 也会使序列保持阻塞，额度等待会显示为 `waiting`。`maxGoalRevisions` 与每个任务的 `maxRevisions` 相互独立。自动目标返工已有自动化覆盖，但真实端到端验收和返工流程尚未验证。

如需在单个任务内提交有序执行阶段，可通过 `--stages-file` 指定 JSON 数组。每个阶段可按需设置 `harnessId`、`modelId` 和 `reasoningEffort`；未指定的字段仍由当前分配器补全。现有的 `--harness`、`--model` 和 `--effort` 选项会设置任务级默认值，阶段中单独指定的字段可以覆盖默认值。每个阶段的最终选择都必须匹配当前可用且已在本机验证的绑定。

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
SQLite 队列 ── Scheduler / 租约 ── 主分配器（Codex 或 API）
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
- [Herdr 生态复用评估](docs/herdr-assessment.md)
- [工作区与跨 Harness 接力设计](docs/workspace-handoff-design.md)
- [路由与审核契约](docs/route-review-contract.md)
- [本地服务配置与绑定验证](src/server/README.md)
- [Windows 无人值守部署](docs/windows-deployment.md)
- [Super Plumber 评估](docs/super-plumber-assessment.md)
- [真实任务验证记录](docs/live-validation.md)
