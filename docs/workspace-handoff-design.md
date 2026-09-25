# Zero 工作区与跨 Harness 接力设计

状态：架构决策草案，2026-09-24。本文记录已核对的上游做法、Zero 当前行为及下一步实现边界。运行中的用户凭据和本机路径不属于项目配置或公开文档。

## 决定

**一个逻辑任务拥有一个 Git worktree。** Codex 分配器、GLM 执行阶段、DeepSeek 执行阶段、机器检查和 Codex 审核属于同一个任务；阶段按顺序接力。需要写代码的阶段在同一个任务 worktree 内运行，前一进程确认结束后才启动下一进程。任务之间和真正并行的子任务各有 worktree；Zero 负责把已通过检查的结果集成到项目分支。

共享目录传递文件状态，Zero 的持久记录传递语义、责任和证据。Harness 原生会话 ID 仅作追踪，不作为跨 Harness 的上下文格式。用户选定的 Harness、模型和思考强度按阶段固定；未选定的字段由 Codex 分配器在已验证的组合中选择。Codex 审核使用新的只读会话。

```text
项目仓库 A ──创建任务分支/worktree W──▶ Codex 分配
                                             │
                                             ▼
                           ZCode + GLM（W，执行）
                                             │ 结构化交接 + Git 状态
                                             ▼
                           ZCode + DeepSeek（W，继续）
                                             │
                                             ▼
                                 Zero 测试/构建（W）
                                             │
                                             ▼
                           Codex 审核（只读、绑定 W 的快照）
                                             │
                              返工回 W / 通过后归档并集成
```

图中 GLM → DeepSeek 是可配置的多执行阶段示例；简单任务只需一个执行阶段。Codex 分配、审核仍保持用户指定的固定角色。Zero 的工作区路径可在界面中打开，ZCode 对该文件夹启动会话。Zero 接入本机 ZCode 时只读取现有提供方配置；每次会话选择模型，不能改写用户在桌面界面选定的默认模型或凭据文件。

## 上游核对与取舍

| 项目 | 已核对的接力机制 | Zero 借鉴 | 边界 |
| --- | --- | --- | --- |
| [AWS CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docusaurus/docs/core-concepts/orchestration-patterns.md) | 同步 handoff、异步 assign、SQLite inbox 消息；[可指定工作目录](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/working-directory.md) | 消息有目标、排队和确认；明确传递 cwd | 相同 cwd 本身不能协调并发写入；其终端编排不是 Zero 的任务状态机 |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/blob/main/docs/cli/README.md) | 已支持 Codex/Claude worker 在同一 session/worktree 切换；原生对话不迁移，结构化 handoff 提交是可选增强 | 保留任务、分支和工作区，新的 Harness 启动新的原生会话 | 当前可切换 Harness 范围不包含 ZCode；不能直接作为 Zero 的通用实现 |
| [Hydra](https://github.com/krowxx/hydra/blob/master/docs/USAGE.md) | 队列、claim、checkpoint、handoff API；可选任务 worktree 与跨模型验证 | checkpoint、交接确认和验证证据 | worktree 默认关闭，不能把默认行为视作隔离保证 |
| [multi-agent-cli-orchestrator](https://github.com/Atman36/multi-agent-cli-orchestrator) | 一个 job 一份 workspace，plan → implement → review；`context.json` 和各阶段 artifact | 同任务顺序流水线及独立阶段产物 | 真实 CLI 默认关闭，项目要求 Linux/macOS |
| [codex-orchestrator](https://github.com/zm2231/codex-orchestrator/blob/main/src/orchestrator/handoff.py) | handoff 包含目标、完成项、当前状态、剩余工作、决策、关键文件和注意事项 | 结构化语义交接 | 写入者按 work item 隔离，不是通用共享 writer worktree |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) | 子 Agent 继承 cwd，结果回传给父 Agent；一次性和可继续会话分开 | Adapter 能力声明、部分结果不能当成功 | 不负责 Zero 的任务队列或项目集成 |
| [Codex + DSH Delegation](https://github.com/LomoMao/delegate-to-deepseek-harness) | Codex 交办有范围的工作，再验证改动范围和检查结果 | 明确交付契约及交叉审核 | 是委派方法，不提供持久调度 |
| [Super Plumber](https://github.com/LUKAWI/super-plumber) | YAML 任务图的依赖、`shares_context`、checkpoint、execution report 和审计事件 | 多阶段依赖与交接单的数据形状 | 只管理拓扑和状态，Zero 仍需拥有执行、进程、Git 与恢复机制 |

Agent Orchestrator 的 [#3317 设计记录](https://github.com/Untrivial-ai/agent-orchestrator/issues/3317)提出更完整的语义交接和进程切换状态机；它已由后续 PR 关闭。现行 CLI 文档把结构化 handoff 作为可选增强，因此本文只把该 issue 当设计参考，不把其中每个步骤当成已发布行为。

## 当前 Zero 与差距

当前 [TaskWorker](../src/orchestrator/worker.ts)已经让路由、多个有序执行阶段、最终测试、审核和返工围绕一个 task worktree 运行；返工保持已有文件。每个执行阶段都单独路由、写入关联尝试、工作树指纹和版本化交接；下一阶段须核对前驱成功与输出指纹，并确认没有活动尝试。后续阶段或额度恢复会核对紧邻前一执行阶段的交接来源、进程代号和当前工作树指纹，再以有界的不可信资料送入提示；不匹配时排除交接，不代替原任务和 Zero 实测事实。审核前先暂存任务输出，固定 Git tree、完整二进制 diff 与工作树指纹；审核后、提交前、提交后及标记 DONE 前逐次核对，防止晚到的写入混进已审核结果。[Reviewer](../src/orchestrator/reviewer.ts)在独立可信目录启动，从暂存 Git blob 构造有界的源码只读快照，包含未改动的调用方和 manifest；项目中的 `AGENTS.md` 与 `.codex` 在快照里改名为资料，避免自动加载。GLM → DeepSeek 的接力已由 fake Harness 测试覆盖，但本机 ZCode 桌面模型尚未完成真实绑定。普通进程崩溃后工作树仍需人工检查；额度暂停已有校验工作树指纹的恢复路径。

跨 Harness 的调度与文件交接现在有可运行的核心路径；真实模型选择、长任务质量和普通崩溃恢复仍待实机验收。

## 权威数据与交接契约

SQLite 是任务、阶段、尝试和交接的权威状态；Zero 数据目录保存日志、diff、测试输出和最终报告。默认不向用户项目仓库自动写入 `.zero/`、`HANDOFF.md` 或模型配置，避免把私有执行日志混进任务提交。界面可展示、导出交接单；若项目明确选择把设计决策提交到 Git，那是单独的受审代码变更。

每个阶段至少记录：

- `taskId`、`stageId`、`attemptId`、前驱阶段、角色、Harness、模型、思考强度、绑定版本和启动代号；
- 任务原文、最新用户指令、验收条件及本阶段目标；
- 项目仓库身份、任务分支、base/HEAD、工作树状态、改动文件和内容摘要；
- 前一执行者的结构化交接：已完成、当前工作、关键决策、未采用方案、相关文件、已运行检查、阻塞、风险、下一步；
- Zero 实测的检查结果、审核意见、产物路径和证据来源。

交接内容按 `schemaVersion` 校验，附来源 Harness/Model/attempt 与创建时间，限定大小并将文本作为不可信资料传给下一阶段。Git 状态和机器检查由 Zero 独立采集；与执行者叙述冲突时以采集事实为准。一次会话额度耗尽或异常退出时可能拿不到语义交接，此时保存“只有已观测事实”的降级交接，并在下一阶段提示先检查现有改动；不能凭摘要推定任务完成。

## 串行、审核与恢复

同一任务同时最多一个写入进程。Zero 在 SQLite 中保留阶段 lease、进程启动代号和预期工作树版本；启动后继前确认前驱进程已退出，重新采集 HEAD、index、已跟踪与未跟踪文件状态。旧进程的迟到结果不得覆盖新阶段。状态不确定时停在可诊断状态，不能启动第二个写入者。

审核仍从可信目录启动新的 Codex 会话，保持只读。Zero 给它**绑定到某个确定 Git 暂存树**的完整 diff、检查证据和源码快照；快照文件取自 index blob，manifest 记录 HEAD、tree、每个文件的 blob ID 与摘要。快照超过边界、存在未暂存且未被忽略的文件、冲突项、符号链接或 Git submodule 时中止审核；不能因为 `cwd` 一致就让审核自动加载项目内的代理指令。审核前后比较工作树版本，结论只对同一暂存树有效；返工回到同一任务 worktree，再次测试与审核。

恢复点在阶段开始和完成边界落盘。额度暂停记录可重试时间，并在时间到后校验同一个工作区继续；服务重启也读取相同记录。普通崩溃先确认旧进程已经终止并核对工作区，再决定从上一个安全阶段续接。工作树指纹必须覆盖未跟踪二进制内容，避免同大小替换逃过校验。超过返工次数或无法确认进程状态时保留 worktree 与报告，标记需要处理的原因。

## 实施顺序和验收

1. **验证接入事实。** 官方 0.16.9 源码表明 `sendText` 可按 `providerId/modelId` 选择模型；Zero 必须同时传 `modelExecution.selectionScope: execution`，使本轮选择不写入会话默认模型。仍需在隔离任务工作区验证本机协议调用、思考等级和退出/取消行为。不得移动或改写用户现有 ZCode 配置。
2. **接通阶段与交接数据。** stage/attempt/handoff 表、版本化 schema、有序多执行阶段，以及按来源与工作树状态核对的交接消费已实现；路由与审核尚未全部纳入同一种阶段记录。
3. **验证串行接力。** fake Harness 已覆盖同一 worktree 的两模型接续、额度暂停恢复与迟到写入拦截；真实 GLM → DeepSeek、进程退出保证和普通崩溃恢复尚待验证。
4. **加强审核。** 有界 Git index 源码快照和提交一致性门禁已实现并由 FakeCodex/本地 Git 测试覆盖；仍需以真实 Codex CLI 验证读取和审核结果，并扩展完整测试证据的按需访问。
5. **项目级集成。** 多任务项目增加项目分支、依赖门禁、已完成任务的集成与冲突处理；并行子任务独立 worktree，不能直接共享一个写入目录。

验收样例：在一个任务中 Codex 分配 → ZCode/GLM 修改 → ZCode/DeepSeek 继续 → Zero 测试 → Codex 审核要求返工 → 指定 Harness 在同一任务工作区修复 → 复测、复审、提交、归档。报告应显示每次阶段选择、工作树版本、交接与证据；服务重启或额度暂停后能从已验证的边界继续。

## 需验证的具体风险

- ZCode 协议的模型选择已从源码确认，尚未用本机用户会话执行真实的 GLM/DeepSeek 任务；若实际启动改变桌面默认配置或不能正确关闭子进程，停止接入并重新设计。
- ZCode 的会话协议可能发出权限或用户输入反向请求；仅等待 `turn.completed` 会让无人值守任务一直停住。接入进程必须按 RPC `id` 回应或明确拒绝，识别订阅快照和增量中的待处理交互，无法安全自动处理时记录阻塞原因并停止该阶段。不可把发送回执当作完成。协议 `session/close` 会删除产品会话；正常收尾应关闭进程资源并保留会话历史。
- 本机审查的 ZCode 版本仍支持 `session/send`，但其源码已将它标为兼容旧客户端的入口，主路径转向 `v4/command` 的 `sendText`。当前未接路由的原型只验证旧协议的事件和生命周期；正式绑定需核对并优先验证 v4 的模型选择、回执、交互与完成事件，或明确锁定已验证版本。
- [ZCode v4 命令 schema](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/command.ts)允许每条 `sendText` 显式提交 `{providerId,modelId,options.reasoningLevel}`；[执行入口](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts)把它固定到本次输入。因此 Zero 应按任务阶段逐条固定模型，并核对实际回合事件。`createSession.config` 应用失败时[会退回会话默认配置](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts)，不能只凭创建会话成功或 ACK 宣称指定模型已执行。以上是上游源码行为，仍须在本机已安装版本做隔离验证。
- 本机桌面包内置的 CLI 版本为 0.16.9，未加入 PATH；只读核对发现同版本源码的 legacy `session/create` 与 v4 `sendText` 共用 app-server 会话。现有桥用 legacy 创建会话与事件游标、v4 每回合显式选模型，按 `commandId`/`inputId` 对齐 `turn.completed`，并以 fake peer 测试。这条路径尚未通过本机现有桌面提供方的真实 nonce 验证，不能注册为可用绑定。v4 `stop` 带当前观测到的 `expectedForegroundExecutionId`，防止迟到的停止命令误杀下一回合。
- ZCode 的反向交互包含权限请求和 AskUserQuestion；[同版本交互注册表](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/interaction-registry.ts)默认会在 AskUserQuestion 到期时自动接受空答案。Zero 独占的 app-server 进程必须先确认 `workspace/updateInteractionPreferences(false)` 生效，并对 `session/requestRuntimePreferences` 明确返回关闭自动收口；该 workspace 命令只改变当前进程的运行偏好，不写用户持久设置。订阅 ACK 后必须等待匹配的 `v4/conversation/frame` 快照，再检查 `pendingInteractions` 及后续 `state.updated` 增量。发现交互时停止该回合并记录阻塞，不能自动允许写入或代填答案；缺少当前 `foregroundExecutionId` 时不可发送无保护的 legacy `session/stop`，需将会话隔离到进程退出并确认工作树状态。
- `sendText.payload.modelSelection` 单独使用会让该选择进入会话状态；要让每个任务回合独立选 GLM/DeepSeek 且不改变会话默认值，必须加 `modelExecution: {selectionScope: 'execution'}`。0.16.9 源码中这一范围跳过 `setSessionModelSelection` 与 `persistRuntimeModelSelection`。Zero 还应设 `memoryExtraction: 'skip'` 关闭本轮自动 Project Memory 提取，设 `subagents: {foregroundModel: 'submission', background: 'deny'}` 让前景子 Agent 继承本轮模型并阻止脱离父回合的后台子 Agent；这些字段不能被解释为禁止所有用户数据写入。真实模型执行及模型身份仍需冒烟测试，成功但没有实际模型回报时只标记 `selector_only`。
- Codex 审核的源码快照已在本地 FakeCodex 测试验证路径和字节一致性，真实 Codex CLI 的阅读能力与质量仍需实测；若大项目超过快照边界，需要设计受限按需读取通道，而不能静默遗漏文件。
- 多个任务目前没有项目集成分支。若用户在主仓库 A 中期望立即看到任务分支的代码，必须完成集成步骤或由界面明确展示任务 worktree，不能把任务隔离误说成主仓库已更新。
