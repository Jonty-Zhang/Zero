# Herdr 生态对 Zero 的复用评估

核查日期：2026-09-25。这里的 Herdr 指 [官方项目 `herdrdev/herdr`](https://github.com/herdrdev/herdr)，不是先前参考清单中的 Hydra。`motionharvest/herdr` 是另一个 fork。评估只读上游仓库和文档；未在目标电脑安装 Herdr，也未修改用户的 ZCode 或其他 Harness 配置。

## 结论

**保留 Zero 现有任务状态与 Harness＋Model 路由，吸收 Herdr 生态中更成熟的门禁、会话观察和恢复做法。** 目前没有证据表明整体换底座能省下大量开发：官方 Herdr 是持久终端运行时，不负责 Zero 的测试、审核和 DONE 判定；`herdr-orchestrator` 虽有完整闭环，却把 GitHub issue→PR→merge 和 Claude Code 当作默认流程，与 Zero 的本地任务、可选执行 Harness 和固定 Codex 审核不同。若局部代码质量或实测明显优于 Zero，可按接口替换该局部，不保护已有实现的形式。

| 项目 | 可取的具体实现 | 对 Zero 的限制 |
|---|---|---|
| [官方 Herdr](https://github.com/herdrdev/herdr) | `src/api/` 状态、事件订阅和等待；`src/workspace.rs`、`src/worktree.rs`；`src/agent_resume.rs`、`src/integration/`。对外优先使用其 [CLI/Socket API](https://herdr.dev/docs/socket-api/) 作可选 pane 观察或控制。仓库当前 [Apache-2.0](https://raw.githubusercontent.com/herdrdev/herdr/master/LICENSE)。 | 不提供 Zero 所需的 verified Harness×Model binding、机器检查、独立 Reviewer 和返工门禁。Herdr server 重启后原 pane 进程不会存活，native agent conversation resume 依赖具体 Harness。[会话恢复说明](https://herdr.dev/docs/session-state/) |
| [herdr-board](https://github.com/bredebjorhovd/herdr-board) | issue 队列、派工、按上游状态派生看板、PR review 反馈给作者 pane。 | 当前仓库根目录未见 LICENSE，且流程需要 Herdr/外部 issue 源；[GitHub 的许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)表明公开可读不等于许可复制修改。只研究行为，不复制源码，除非作者明确授权。 |
| [herdr-orchestrator](https://github.com/sean1588/herdr-orchestrator) | `internal/config/validate.go` 与 `workflow.schema.json` 的形状＋语义不变量；`internal/engine/` 的确定性状态图；`internal/store/` 的状态审计；`internal/exec/` 的执行后端边界。其[工作流说明](https://github.com/sean1588/herdr-orchestrator/blob/main/docs/WORKFLOW.md)明确把模型判断限制在闭合集合、把重要转换交给权威证据门禁，并设置超时与循环上限。仓库声明 [Apache-2.0](https://github.com/sean1588/herdr-orchestrator). | Go 服务面向 GitHub issue/PR/自动 merge，默认 Claude Code；发布说明只列 macOS/Linux。直接搬进 TypeScript/Windows Zero 会重新实现队列、路由、适配器和报告。上游[路线图](https://github.com/sean1588/herdr-orchestrator/blob/main/ROADMAP.md)也记录旧 reviewer verdict 复用与恢复配置不一致等风险，不能仅凭设计文档认定实现更安全。 |
| [Herdr Harness Coordinator](https://github.com/hewel/herdr-harness-coordinator) | Supervisor/Worker 和持久消息交接的设计词汇。 | 当前主要为文档、schema 和脚本；缺少可直接运行的实现与明确可复制许可。 |

## Windows 与进程恢复

[官方当前 Windows 文档](https://herdr.dev/docs/windows-beta/)已把原生 Windows 标为 generally available，稳定通道为常规使用首选。ConPTY pane、客户端脱离后的会话持续、常见 agent 进程识别和 Git worktree 检测均列为支持；插件仍为 preview，直接 terminal attach 和 live server handoff 在 Windows 不支持。早期讨论和页面路径中的“beta”不代表当前状态。

Herdr 客户端关闭时，server 可以让 pane 进程继续工作；Herdr server 停止或整机重启后，只恢复工作区形状、cwd 等快照，不保留旧进程。因此不能用 Herdr 的 session restore 替代 Zero 的 guardian 进程树停止证明、任务阶段日志和 Git/审核证据重验。若把 Herdr 置于 Zero guardian 的 Job 内，guardian 退出会清理它；若放在 Job 外，Zero 必须额外持久记录 pane/进程身份并证明旧写入者已停止，才可接管同一 worktree。

## 可执行的取舍

1. **先吸收门禁规则。** 对照 `herdr-orchestrator` 的配置校验、有限返工、审核结论与准确代码版本绑定、运行超时和可观察进度。只把 Zero 现有代码没有覆盖、且可复现的缺口列入实施；不复制整套 Go 状态机。复制 Apache 源码前应固定上游 commit，核查该 commit 的许可证、NOTICE 和文件署名，再保留相应声明。
2. **把普通崩溃恢复放在 Herdr 集成之前。** Zero 仍需把 guardian 代际、阶段意图、进程结束证据、工作树快照和审核指纹关联起来；详见[普通崩溃恢复设计](crash-recovery-design.md)。Herdr 的 pane 生命周期不能放宽这些门槛。
3. **若需要旁路可视化，再做隔离 spike。** 只对一个已验证的 Codex 任务接入 Herdr CLI/Socket；保持 Zero 的 TaskStore、Router、Reviewer 和 DONE 判定。必须实测结构化 final、真实退出码、取消、pane 身份重用防护和 Windows 稳定版表现。若 `RunResult` 证据不足，Herdr 只能作为可选观察入口，不能成为权威执行后端。

本评估不把上游 README 的功能宣称等同于 Zero 在目标机器上的验证。会改变取舍的证据是：Herdr 后端在同一 Windows 账户下通过完整执行、取消、重启接管与审核绑定测试，且移植后的代码量和故障面实测低于现有 Zero 路径。
