# Zero

[English](README.md)

Zero 是一个在本机管理多个编程 Agent 的项目工作台。在网页中选择或新建文件夹，描述目标，可选填写 Boss 和团队偏好，例如“Codex gpt6.1sol high 负责设计，具体实现优先交给便宜模型或 DeepSeek Harness”。Boss 会根据已连接且验证过的模型确定实际负责人，研究项目、按需咨询其他 Agent、制定方案和验收方式，再派发执行并验收。Windows 上需要手动启动本地服务；启动器保持打开时，关闭浏览器不会停止任务。

Zero 是一个由 Node.js 服务、本地 React Web 界面和 CLI 组成的独立应用。服务负责任务状态和执行，界面是该服务的客户端。v1 面向 Windows 优先的单机单用户环境，默认只监听回环地址。

## 当前已实现

- 在“管理连接”中输入 Codex 模型和思考强度，主动点击“验证并接通”。验证会使用一次模型额度；成功后 Boss 直接使用，无须重启。进度会保存，关闭窗口或断线重试会取回原作业。Zero 使用的 Codex 环境须已有登录授权；本轮没有新增账户登录或桌面聊天接管。详见[连接说明](docs/codex-desktop-integration.md)。
- 默认 Boss 项目入口只需文件夹和目标。无需自己创建 Git 历史、填写检查命令、返工次数或手工分工。普通文件夹会建立本地快照；已有 Git 项目使用当前文件的独立快照，不修改用户分支、暂存区或原文件。模型偏好可用自然语言填写，实际采用的模型和理由会显示在详情中；未连接或未验证的模型不会被伪装成可用模型。
- Boss 支持 Codex、DSH 和 ZCode 之间的设计咨询及串行任务接力。完成中间阶段后可根据真实交接和新增要求调整剩余方案；最终检查会实际执行，验收使用新的 Codex 会话。开始验证后不会改写已绑定的检查契约。复杂度和成本选择由 Boss 决定，自动返工仍有明确上限，避免无限消耗。
- 详情展示方案、讨论、执行和验收证据，以及真实成果文件夹、分支和结果提交；可复制成果路径查看文件。结果保留在任务工作目录，原选目录不会自动覆盖。执行期间可补充要求；正在验收或已结束时不能追加未处理消息，可新建后续任务。
- 跨 Agent 任务工作台支持列表/看板、搜索和状态筛选。刷新失败保留上次证据并提示数据可能过期。旧的检查命令、执行默认值和手动序列位于高级模式，仍可供需要精确控制的任务使用。详见[网页说明](web/README.md)。
- 基于 SQLite 的任务队列和本地 HTTP API，任务状态包括 `pending`、`running`、`reviewing`、`revision`、`waiting`、`recovery_required`、`done` 和 `failed`。
- 高级手动模式的路由分配器可使用 Codex 订阅或兼容 OpenAI API 的 HTTPS 模型；用户可固定 Harness、模型和思考强度。默认 Boss 项目使用已确定的负责人设计和验收，执行模型由负责人选择。
- 高级模式的执行默认值可以保存为全局选择和按仓库路径匹配的项目选择。手动任务按任务 → 项目 → 全局 → 分配器逐级补全；Boss 项目不受这些旧默认值锁定。
- API 分配器在 Web 界面中配置：`baseUrl` 必须是 HTTPS 地址，`model` 是分配器模型，`keyEnv` 是 Zero 服务进程可读取的环境变量名称。Zero 只保存变量名，不保存 API 密钥；密钥由 Zero 服务进程环境提供。Codex Reviewer 保持不变。
- Codex、DeepSeek Harness（DSH）和 ZCode 适配器。存在适配器不代表 Harness/模型组合已可用于路由：Zero 要求先验证绑定。DSH 和隔离式 ZCode CLI 绑定使用 Zero 自有配置档。现有桌面 ZCode `app-server` 适配器已用本机配置的三种 API 模型和显式思考等级通过 nonce 验证；绑定保存在 Zero 本地数据中。CI 构建的安装版已完成 GLM Flash API 任务和 GLM Flash → DeepSeek Flash 两阶段任务，均经过 Codex 分配、Zero 检查、独立 Codex 审核、结果提交和报告归档并到达 `done`。此前一次安装版任务在正确写入后失败，原因尚未定位；这两次验收不能证明任意任务的无人值守可靠性。验证边界见[服务端配置](src/server/README.md)和[真实任务验证记录](docs/live-validation.md)。
- 每个任务使用独立 Git worktree，运行配置的验证命令，限制返工次数，并归档包含执行、测试、审核和 Git 证据的报告。成功任务的分支保留在源代码仓库中；Zero 不会自动合并或推送分支。
- 有序 `executionStages` 已通过核心、HTTP API 和 CLI 的 `--stages-file` 选项实现，会在同一个任务 worktree 中串行执行。每个阶段会记录关联尝试、工作树指纹，以及由 Zero 实测事实构成的版本化交接单；报告收录这些阶段记录。
- 可持久保存并按序执行多个任务步骤，可通过 Web 界面或 API 提交，并用 CLI 查询。每一步都是普通任务，可分别手动指定 Harness、模型和思考强度；留空字段先继承匹配的项目和全局默认值，再由当前分配器补全。同一仓库中的步骤会在前一步达到 `done`、并具有权威应用提交和完整报告后，从该步骤的已验证结果提交开始。
- 序列状态会区分步骤执行和整体目标验收。所有步骤任务完成后，如果提供了整体目标或目标级验收标准，Zero 会运行独立的汇总 Codex 验收。HTTP API 和界面会展示最近一次验收的状态、判定（`PASS`、`changes_requested` 或 `blocked`）、摘要、发现和额度重试时间。`steps_completed` 表示尚无可用的汇总判定；`completed` 表示未提供目标级信息，或汇总验收返回 `PASS`。收到 `changes_requested` 后，Zero 最多可自动追加并执行 `maxGoalRevisions` 个目标级返工任务（默认 `2`，允许 `0`–`5`）；`goalRevisionCount` 显示已使用次数。达到上限但仍未得到 `PASS` 时，序列保持阻塞，并在 API 和界面显示原因。2026-09-27 的已安装版验收中，两项有序任务均到达 `done`，各自的一项检查及 Codex 审核均通过。步骤 2 的 `effective_base_commit` 与步骤 1 报告中的 `resultCommit` 完全一致，且步骤 2 有独立的 `resultCommit`。最终文件为精确 LF 行尾，汇总 Codex 审核返回 `PASS`，序列变为 `completed`，`goalRevisionCount=0`；退出启动器后服务停止。此前两轮分别因 CRLF 和无法从最终事实观察的内部读取标准而被阻塞；最终轮使用可观察结果作为标准。详见[真实任务验证记录](docs/live-validation.md)。
- 对已验证的模型使用额度限制提供 `waiting` 状态、持久检查点和跨服务重启的定时重试。自动化测试覆盖分配、执行、审核和审核要求返工期间的额度续跑；尚未观察到真实提供方的额度限制事件。普通崩溃时，Zero 先隔离过期租约。原生 guardian 证明上一代进程 Job 已清空后，合格任务可在已登记的同一 worktree 中恢复：首次执行、已封存审核包的审核与提交/报告，以及审核要求的返工。恢复的执行和返工会重新路由、建立新的尝试、重跑检查和审核。恢复必须匹配任务代际、Git 身份、允许修改路径、审核包及结论、返工次数等证据；证据缺失或不符时任务保留在 `recovery_required` 等待检查。
- 恢复实现已包含自动化测试。目标电脑上的安装和手动启动已验证，真实 Codex 订阅绑定检查也已成功。目标电脑上的隔离式故障注入已验证单阶段执行崩溃这一受限路径：启动器重启 guardian，同一任务创建新的路由与实现尝试，重新通过检查和 Codex 审核，并保存结果提交与报告后到达 `done`。真实提供方额度耗尽及恢复、其他崩溃边界和 DSH 实时执行仍未验证。忽略的构建/缓存文件不包含在 Zero 基于 Git 的 worktree 指纹中；它们可能留在 worktree 并影响恢复后的命令，因此应使用可重复的检查，不要依赖隐藏的本地缓存状态。详见[崩溃恢复设计](docs/crash-recovery-design.md)和[恢复实现边界](docs/crash-recovery-next-slice.md)。
- 创建 worktree 前会持久记录目标仓库、分支、路径和基点；`git worktree add` 成功后再记录实测身份与指纹。创建结果不确定时保留这些证据并等待检查。
- 原生 Windows 进程 guardian 已在 CI 中通过构建、进程包含和发布目录手动启动测试。用户手动启动受监督服务；非零退出时启动器会退避重试，启动器退出时 guardian 会结束服务进程树。目标电脑上的安装和手动启动已验证；开机或登录自启不属于部署方式。详见 [Windows 部署](docs/windows-deployment.md)。
- Windows 发布目录脚本可打包已构建的服务、界面、CLI、显式指定的 Node 运行时与 guardian，并生成文件哈希清单。独立校验器在 CI 中核对所有文件并启动包内 CLI。未签名 NSIS 安装包已在 CI 中通过构建、安装/卸载和手动启动检查。2026-09-27，提交 `4b26a85` 的 CI 全部通过；其 42 文件安装包已在目标电脑安装，清单哈希全部匹配，且未注册计划任务。隔离 Git 测试仓库中的任务依次经过 `running` → `reviewing` → `done`；路由、实现、审核三次尝试均成功，一项检查通过，独立审核通过，并生成结果提交和报告，差异仅包含 `acceptance.txt`。详见 [Windows 单应用安装包](docs/windows-app-packaging.md)和[真实任务验证记录](docs/live-validation.md)。

## 尚属设计或待验证的目标

- ZCode 桌面接入已有三组基于 nonce 的 `selector_only` 本机验证证据，分别对应用户配置的 GLM Flash、DeepSeek Flash 和 DeepSeek Pro API 模型。空会话目录会列出精确提供方/模型标识及可选思考等级；CI 构建的正式安装版已完成 GLM Flash 任务和 GLM Flash → DeepSeek Flash 两阶段任务的执行、检查、独立 Codex 审核、提交和报告归档。DeepSeek Flash 已有该真实接力任务证据；DeepSeek Pro 仍仅通过 selector 验证。此前一次安装版任务在正确写入后失败，原因尚未定位；成功验收不能证明任意任务的无人值守可靠性。Start Plan 未出现在本次目录中，仍未验证。适配器不会声称已确认实际响应模型身份、计费来源，也不会迁移桌面会话上下文。详见[接入设计](docs/zcode-existing-desktop-enrollment.md)和[真实任务验证记录](docs/live-validation.md)。
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

每个任务条目使用与 `submit` 相同的字段：`repoPath`、`baseRef`、`prompt`、可选的 `acceptanceCriteria`、`checkCommands`、`maxRevisions` 和可选的 `execution`。每一步都要重复填写仓库和基础 Ref。手动执行选择放在 `execution.harnessId`、`execution.modelId` 和 `execution.reasoningEffort`；每个未指定字段会先检查匹配的项目默认值，再检查全局默认值，最后由当前分配器从已验证绑定中补全。

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

请将仓库路径和绑定占位符替换为实际值。手动指定的 Harness、模型和思考强度组合必须当前可用并已验证；步骤按文件中的顺序保存。同一仓库中的后续步骤从前一步的已验证结果提交开始。提供整体目标信息时，所有步骤完成后 Zero 会运行汇总 Codex 验收，并在序列 API 和界面中展示当前状态与结果。验收 `PASS` 后状态为 `completed`；`changes_requested` 可触发自动追加的整体目标返工任务，最多为 `maxGoalRevisions` 次（默认 `2`，允许范围 `0`–`5`），`goalRevisionCount` 展示已使用次数。返工上限用尽仍未通过时，序列保持阻塞并显示原因；`blocked` 也会使序列保持阻塞，额度等待会显示为 `waiting`。`maxGoalRevisions` 与每个任务的 `maxRevisions` 相互独立。自动目标返工已有自动化覆盖；第三轮已安装版 Goal E2E 于 2026-09-27 返回 `PASS`，详见[真实任务验证记录](docs/live-validation.md)。

如需在单个任务内提交有序执行阶段，可通过 `--stages-file` 指定 JSON 数组。每个阶段可按需设置 `harnessId`、`modelId`、`reasoningEffort`，以及 1–4000 字符的独立 `objective`。阶段选择覆盖任务级选择，剩余未指定字段按任务 → 项目 → 全局 → 当前分配器补全；提交时会校验继承后的有效组合。阶段目标补充整体任务，返工时仍必须遵守原始验收与具体审查意见。

执行者的最终答复会保存为有界 `executorSummary`，进入尝试、交接与报告，并以不可信资料传给下一位 agent。它不能替代 Zero 采集的 Git 与检查证据。网页支持目标编辑与排序、执行者自述，以及当前/历史检查分区；提交请求超时或断线后使用持久幂等身份重试，避免重复创建任务。详见[第二轮深入审查记录](docs/2026-10-17-semantic-relay-audit.md)。

```json
[
  { "harnessId": "<first-harness-id>", "modelId": "<first-model-id>", "objective": "实现存储层，保持现有公开接口。" },
  { "harnessId": "<second-harness-id>", "modelId": "<second-model-id>", "reasoningEffort": "high", "objective": "接入消费者，并验证空输入行为。" }
]
```

请将示例 ID 替换为已验证绑定的 ID，将内容保存为 `stages.json`，然后运行 `node dist/cli.js submit --repo 'C:\path\to\repo' --prompt '实现存储层并完成消费者接入' --check 'npm test' --stages-file stages.json`。检查命令应换成该仓库实际使用的验证命令，Zero 必须通过已配置检查才能完成任务。API 会校验每个最终组合，并按提交顺序保存。

CLI 还提供 `node dist/cli.js cancel <task-id>`。不带参数运行 `node dist/cli.js` 可查看全部选项。Web 界面和 CLI 共用本地服务与任务队列。

首次运行时，不会假设已有经过真实验证的模型绑定。提交任务前，请按照[服务端配置与绑定验证说明](src/server/README.md)操作。绑定验证可能会真实调用模型。不要把 API 密钥、代理凭据或其他机密放入仓库或 Zero 的模型注册表；身份验证由对应 CLI 的登录状态或进程环境提供。DSH 和隔离式 ZCode CLI 绑定使用服务端说明中由 Zero 管理的配置档。单独的 ZCode 现有桌面接入路径使用 app-server 会话，不复制或编辑桌面配置。

## 运行数据与隐私

默认情况下，Zero 将 SQLite 数据库、本地配置、worktree、日志、验证记录和报告保存在源码目录之外：Windows 使用 `%LOCALAPPDATA%/Zero`，其他平台使用 `~/.local/share/zero`。开发时可将 `ZERO_DATA_DIR` 指向源码目录中的位置；`data/.zero/` 已被 Git 忽略。请保护此数据目录，其中的任务提示、diff、命令输出和报告可能包含项目敏感信息。

HTTP 服务默认绑定 `127.0.0.1:4179`，v1 不支持远程绑定。Git worktree 可以将任务改动与主工作区分开，但它**不是操作系统安全沙箱**。Zero 服务和验证命令使用启动器所在的 Windows 用户权限，因此应使用仅能访问指定仓库和凭据的低权限账户。验证命令以子进程运行，应视为代码执行。

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
- [Windows 手动部署](docs/windows-deployment.md)
- [Super Plumber 评估](docs/super-plumber-assessment.md)
- [真实任务验证记录](docs/live-validation.md)
