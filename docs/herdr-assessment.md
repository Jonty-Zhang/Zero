# Herdr 生态对 Zero 的复用评估

核查日期：2026-09-25。这里的 Herdr 指 [官方项目 `herdrdev/herdr`](https://github.com/herdrdev/herdr)，不是先前参考清单中的 Hydra。`motionharvest/herdr` 是另一个 fork。评估只读上游仓库和文档；未在目标电脑安装 Herdr，也未修改用户的 ZCode 或其他 Harness 配置。

## 结论

**对 Zero 当前“本地 task store + 可选 Harness/Model + Codex review”的目标，不建议替换核心底座；对于 GitHub issue→PR→merge 的无人值守目标，`herdr-orchestrator` 已是一套可直接试跑的完整基线，确实可能省去大量流程开发。** 官方 Herdr 本身是持久终端运行时，不负责 Zero 的测试、审核和 DONE 判定。Orchestrator 的既有闭环绑定 GitHub issue/PR、Herdr pane 和以 Claude 为默认运行条件；采用它会切换任务来源、状态存储与执行/恢复合同，不能当作在 Zero 上无成本启用一个复用模块。先用隔离 spike 实测“上游直接试跑”与“保留 Zero 接后端”的总迁移量；若仅需 Zero 当前本地闭环，按接口借鉴局部即可，若产品决定切到 GitHub PR 工作流，则允许以完整上游基线替换对应流程，不逐文件搬代码。

| 项目 | 可取的具体实现 | 对 Zero 的限制 |
|---|---|---|
| [官方 Herdr](https://github.com/herdrdev/herdr) | `src/api/` 状态、事件订阅和等待；`src/workspace/git/` 的 Git workspace 检测与状态；`src/persist/snapshot.rs`、`src/persist/restore.rs`；`src/agent_resume.rs`、`src/integration/`。对外优先使用其 [CLI/Socket API](https://herdr.dev/docs/socket-api/) 作可选 pane 观察或控制。仓库当前 [Apache-2.0](https://github.com/herdrdev/herdr/blob/master/LICENSE)。 | Git workspace 模块不是 Zero 这种任务级 worktree 创建/审核快照管理器。Herdr 不提供 Zero 所需的 verified Harness×Model binding、机器检查、独立 Reviewer 和返工门禁。Herdr server 重启后原 pane 进程不会存活，native agent conversation resume 依赖具体 Harness。[会话恢复说明](https://herdr.dev/docs/session-state/) |
| [herdr-board](https://github.com/bredebjorhovd/herdr-board) | issue 队列、派工、按上游状态派生看板、PR review 反馈给作者 pane。 | 当前仓库根目录未见 LICENSE，且流程需要 Herdr/外部 issue 源；[GitHub 的许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)表明公开可读不等于许可复制修改。只研究行为，不复制源码，除非作者明确授权。 |
| [herdr-orchestrator](https://github.com/sean1588/herdr-orchestrator) | `internal/config/validate.go` 与 `workflow.schema.json` 的形状＋语义不变量；`internal/engine/` 的确定性状态图；`internal/store/` 的状态审计；`internal/exec/` 的执行后端边界。其[工作流说明](https://github.com/sean1588/herdr-orchestrator/blob/main/docs/WORKFLOW.md)明确把模型判断限制在闭合集合、把重要转换交给权威证据门禁，并设置超时与循环上限。仓库声明 [Apache-2.0](https://github.com/sean1588/herdr-orchestrator/blob/main/LICENSE)。 | Go 服务面向 GitHub issue/PR/自动 merge；README 的实跑前提包括 Herdr、GitHub CLI 与 Claude Code。直接搬进 TypeScript Zero 会重做领域状态、适配器和报告；若可接受它的 GitHub/Herdr 流程，直接试跑完整服务可能省掉流程实现。上游[路线图](https://github.com/sean1588/herdr-orchestrator/blob/main/ROADMAP.md)也记录旧 reviewer verdict 复用与恢复配置不一致等风险，不能仅凭设计文档认定实现更安全。 |
| [Herdr Harness Coordinator](https://github.com/hewel/herdr-harness-coordinator) | Supervisor/Worker 和持久消息交接的设计词汇。 | 当前主要为文档、schema 和脚本；缺少可直接运行的实现与明确可复制许可。 |

## 源码级比较：哪些实现值得替换，哪些只借鉴

核查日期：2026-09-25。Herdr 官方仓库默认分支为 `master`；`sean1588/herdr-orchestrator` 默认分支为 `main`。下表按上游当前文件树和文档评估；分支是可变引用，任何复制或 cherry-pick 前都要先锁定并复核具体 commit。

| 能力 | Herdr / herdr-orchestrator 的源码位置与已核实机制 | Zero 当前实现对照 | 取舍 |
|---|---|---|---|
| 持久化与任务状态 | `herdr-orchestrator/internal/store/task.go` 定义 task 行及持久 `WorkflowSnapshot`；`internal/store/` 以 SQLite 保存 task 和转换审计。`internal/engine/engine.go` 是解释 YAML 状态图的唯一状态写入者。这里的优势是显式声明 workflow、重启时保存任务所处的流程版本，适合“GitHub issue → PR → merge”流程。 | `src/core/task-store.ts` 已用 SQLite 事务维护状态、lease、attempt/stage、handoff、route/check/review、quota checkpoint 和事件；状态迁移有合法性约束。`src/domain/types.ts` 与 `src/orchestrator/worker.ts` 已把 execution/review/revision 路径固定成 Zero 所需门禁，包含当前配置的 route evidence。 | **不替换 TaskStore。** Zero 已有同类耐久性且记录粒度更贴近本地 Harness 执行。若未来要让用户定义任意 YAML DAG，可借鉴 engine/store 分层和 workflow snapshot 的概念；这会触及 task schema、启动/恢复路径、迁移和事件审计，属于中到大的功能重构，并非现成模块移植。 |
| 进程/会话恢复 | 官方 Herdr 的 `src/persist/snapshot.rs` / `restore.rs` 保存和还原 pane/layout/workspace 快照；`src/agent_resume.rs` 将允许的 session 来源/类型映射为受支持 Harness 的 resume argv。Herdr 让客户端断开时后台 pane 继续运行，但 server/机器重启会终止原进程，恢复依赖 agent 原生 session。Orchestrator 的 `internal/exec/herdr.go` 用持久 workspace label 调 `Resolve` 重新定位 volatile pane id。 | `src/core/task-store.ts::recoverExpired` 将过期 lease 放入 `recovery_required`，记下 claim generation、attempt 和 stage/process 身份；它不会把 lease 过期当作旧写入者已退出。仅有新创建前且证明 worktree 不存在、没有持久写入证据的窄路径可自动重排队。Quota 是另一条显式 resume 路径：checkpoint 必须和 worktree 指纹、stage/revision 相符。 | **不替换 Zero 的恢复策略。** Orchestrator/Herdr 的标签重定位适合仍活着的后台 pane；它不证明已死/失联的旧 writer 停止，也不等于安全接管 dirty worktree。可借鉴 pane ID 不持久化、按受校验 label 重解引用的做法，前提是做 Herdr 执行后端并另存 Zero 的 lease/generation 与 writer-stop 证明。 |
| worktree | 任务级 worktree 主要见 `herdr-orchestrator/internal/exec/herdr.go::Spawn` / `addWorktree` / `Cleanup`：确定性目录与 task label、Git worktree、分支复用和 Herdr workspace 生命周期。这是端到端配线实例，不是独立的通用 worktree 库；`Spawn` 的清理/重建语义和 `PreserveBranch` 分支约定与 Zero 的任务恢复合同不同。官方 Herdr 的 `src/workspace/git/` 是 repo/worktree 检测与状态模块，不负责 Zero 式任务 branch 的审计/提交。 | `src/core/git-worktree.ts` 建立任务分支与真实 worktree；会校验 repo/path 身份、changed paths 边界，生成 fingerprint；review snapshot 记录 staged tree ID、diff 与 diff hash，拒绝未 staged 改动；commit 前后验证被审树身份。 | **不替换 GitWorktreeManager。** 当前差异中 Zero 的证据边界更严格、且已有真实 Git 测试覆盖。可借鉴稳定 task label/path convention 作为定位辅助，但不能让 deterministic path 或 Herdr pane label 取代 Git tree/fingerprint 校验。 |
| review 与返工 | `herdr-orchestrator/internal/engine/decision.go` 执行 constrained decision（读结构化 verdict）；`internal/engine/engine.go` 以有限 `retry_caps` 做 `changes_requested → implementer resume`；merge gate 用 GitHub PR/CI/review/mergeability 的权威状态。适合 PR 流程中把模型 verdict 与可合并证据分开。 | `src/orchestrator/worker.ts` 将验证失败/Reviewer 的 changes_requested 映射为有上限的本地 revision；独立 Codex reviewer 读只读快照，校验 schema、attempt 和当前 Git snapshot；quota 后复核检查证据与树身份。当前本地目标不以 PR/merge 为最终真值。 | **借鉴 authority 分层，不移植 decision runner。** upstream ROADMAP 明确记录 `decision.go` 的风险：新一轮 verdict 文件按 task ID 复用，若 reviewer 本轮没有写文件，可能误读上轮 verdict；roadmap 提案是 spawn 前清理 verdict 文件并记录读失败。Zero 当前 `saveReview` 与 attempt 关联，没有这种文件复用路径。 |
| 测试和维护证据 | 上游 README 给出 `go test ./...`、`go vet ./...`；Actions 当前可见持续运行。README/ROADMAP 也记录 live dogfooding 后修复 CLI 兼容、kickoff delivery、超时和门禁问题，体现活跃迭代。更关键的是同一 ROADMAP 仍指出：正常 daemon restart 路径 `Run → ensureTask` 没读取保存的 `WorkflowSnapshot`；one-shot `Recover` 和 daemon 对 settled/resume 的判断已经分叉；共享 event hub 的跨 pane 事件隔离缺少测试。 | Zero 有独立测试覆盖事务迁移、lease 过期隔离、quota restart、真实 Git worktree/tree identity、review 与有限 revision；本轮新增的 checks-tree binding 回归也属于当前源码。但它仍需要真实 Windows guardian/进程生命周期运行时验证，测试通过不能代替设备级崩溃恢复实测。 | **没有证据支持把 orchestrator 的状态机视为更可靠的底座。** 它的配置化广度和 GitHub 闭环领先；Zero 的 writer 隔离与本地快照/提交证据更贴合本产品。上游 roadmap 暴露出的 workflow snapshot 和 stale verdict 缺口应先被修复并有测试证明，再评估迁移。 |

### 具体可复用边界与迁移成本

- **低成本，推荐借鉴，不复制代码：** 从 `herdr-orchestrator/internal/config/validate.go` 与 `internal/config/workflow.schema.json` 提取“结构 schema + 图不变量”的检查清单。如果 Zero 将来开放可配置状态流，先对 Zero 状态迁移/检查/返工预算建立显式不变量，再决定是否增加 DAG 配置。当前固定状态图已由 `TaskStore.transition` 和 worker 分支守住，近期重写没有收益。
- **中成本、只在接入 Herdr 执行 backend 时采用：** 参考 `internal/exec/herdr.go::Resolve` 的“label 是稳定外键，pane ID 是临时句柄”，以及 `Spawn`/`Cleanup` 对 workspace 生命周期的封装。需新增 `HarnessAdapter`/执行 backend 适配、Windows 进程树/取消语义、启动身份证明和端到端测试；不可直接把 Spawn 的强制清理策略搬进 Zero。
- **不建议摘取：** `internal/store/task.go` / `internal/engine/engine.go` 的 Go 状态引擎、SQLite schema 与调度器。它们紧耦合 GitHub issue 身份、PR 分支、workflow snapshot、herdr pane 与 merge gate；移入 TS Zero 相当于重做领域模型和恢复语义。若产品改成 GitHub issue→PR→merge，优先在隔离 spike 中部署上游完整 daemon，对比改造它的任务来源/模型路由成本与保留 Zero 的总成本，而不是逐文件搬迁。
- **不复制已有缺陷：** `internal/engine/decision.go` 的 verdict 文件复用风险，以及 roadmap 已标注的 workflow snapshot 在 daemon 路径不生效、settled predicate 分叉、跨 pane event filter 缺测试；写任何 adapter 或移植代码前要求对应缺陷有修复 commit 和回归测试。

### 许可

官方 Herdr 与 `herdr-orchestrator` 的 GitHub 仓库均显示 Apache-2.0 许可：[Herdr LICENSE](https://github.com/herdrdev/herdr/blob/master/LICENSE)、[Orchestrator LICENSE](https://github.com/sean1588/herdr-orchestrator/blob/main/LICENSE)。如果复制/修改其源码，要固定原始 commit，并按 Apache-2.0 保留版权/许可声明、附带上游 `NOTICE`（若该版本存在）、标明修改，并检查依赖各自许可证。只把公开 README/设计机制转述进 Zero 文档不等同于复制实现代码。

## Windows 与进程恢复

[官方当前 Windows 文档](https://herdr.dev/docs/windows-beta/)已把原生 Windows 标为 generally available，稳定通道为常规使用首选。ConPTY pane、客户端脱离后的会话持续、常见 agent 进程识别和 Git worktree 检测均列为支持；插件仍为 preview，直接 terminal attach 和 live server handoff 在 Windows 不支持。早期讨论和页面路径中的“beta”不代表当前状态。

Herdr 客户端关闭时，server 可以让 pane 进程继续工作；Herdr server 停止或整机重启后，只恢复工作区形状、cwd 等快照，不保留旧进程。因此不能用 Herdr 的 session restore 替代 Zero 的 guardian 进程树停止证明、任务阶段日志和 Git/审核证据重验。若把 Herdr 置于 Zero guardian 的 Job 内，guardian 退出会清理它；若放在 Job 外，Zero 必须额外持久记录 pane/进程身份并证明旧写入者已停止，才可接管同一 worktree。

## 可执行的取舍

1. **先吸收门禁规则。** 对照 `herdr-orchestrator` 的配置校验、有限返工、审核结论与准确代码版本绑定、运行超时和可观察进度。只把 Zero 现有代码没有覆盖、且可复现的缺口列入实施；不复制整套 Go 状态机。复制 Apache 源码前应固定上游 commit，核查该 commit 的许可证、NOTICE 和文件署名，再保留相应声明。
2. **把普通崩溃恢复放在 Herdr 集成之前。** Zero 仍需把 guardian 代际、阶段意图、进程结束证据、工作树快照和审核指纹关联起来；详见[普通崩溃恢复设计](crash-recovery-design.md)。Herdr 的 pane 生命周期不能放宽这些门槛。
3. **若需要旁路可视化，再做隔离 spike。** 只对一个已验证的 Codex 任务接入 Herdr CLI/Socket；保持 Zero 的 TaskStore、Router、Reviewer 和 DONE 判定。必须实测结构化 final、真实退出码、取消、pane 身份重用防护和 Windows 稳定版表现。若 `RunResult` 证据不足，Herdr 只能作为可选观察入口，不能成为权威执行后端。

本评估不把上游 README 的功能宣称等同于 Zero 在目标机器上的验证。会改变取舍的证据是：Herdr 后端在同一 Windows 账户下通过完整执行、取消、重启接管与审核绑定测试，且移植后的代码量和故障面实测低于现有 Zero 路径。
