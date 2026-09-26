# Zero 无人值守恢复设计（历史方案，已被取代）

> 本文保留历史架构讨论。当前 Windows 运行方式是用户手动启动常驻服务；不注册开机触发器或 Task Scheduler 任务，也不请求 Windows 账户密码。请以 [Windows 手动部署](windows-deployment.md)为准。

状态：历史架构决策，2026-09-25。本文中的 Task Scheduler 和开机自启建议已被取代。额度等待、写入前安全重排与执行中崩溃恢复的当前进展与验收边界见[普通崩溃后的安全恢复](crash-recovery-design.md)。

## 当前事实

- `TaskStore.pauseForQuota` 将可信的提供方额度错误写成 `waiting`、重试时间和阶段 checkpoint，释放 lease；调度器每秒尝试领取到期任务。Worker 恢复时核对原 worktree 指纹、路由和检查证据。这条路径已有进程重启单元测试，但尚未观察到真实订阅额度耗尽及五小时重置。
- 普通 lease 过期由 `recoverExpired` 原子隔离为 `recovery_required`，不中途暴露为可领取的 `pending`。仅当前领取协议版本、尚无 worktree 创建意图或任何执行证据、且目标 worktree 路径不存在的写入前任务，才能经专用事务重新排队。已有 worktree 或不确定证据仍等待安全恢复。
- `runProcess` 在父进程活着时可用 `taskkill /T /F` 停止 Windows 子进程；若 Zero 自身突然退出，这段清理代码不能执行。stage 的 `processStartId` 是 UUID，不是可供新进程证明旧子进程已结束的 OS 身份。
- 早期仓库包含 Windows Task Scheduler 安装脚本，现已移除。原生 guardian 仍为同一用户/数据目录持有命名 mutex，继任实例等待旧命名 Job 的活动进程清零；公开 CI 已测试这一机制。当前 TaskStore 的恢复证据与实机验收边界见[普通崩溃后的安全恢复](crash-recovery-design.md)。

## 决定

Zero 的恢复以**先确认旧写入者停止，再核对工作树，再续接阶段**为硬门槛。恢复器不能仅凭 lease 到期、PID 不存在或报告文件存在就断言任务安全。SQLite 是状态权威，Git tree/index/工作树是文件权威；两者不一致时进入可诊断的 `recovery_required` 状态，而不是把任务送回普通 `pending`。

1. **进程包含。** Windows 采用随 Zero 一起打包的轻量原生 guardian：它在 Job 外持有非继承的 Job 句柄和数据目录单实例 mutex，先以 `CREATE_SUSPENDED` 创建现有启动器，再将其加入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 且不允许 breakaway 的 Job，最后恢复线程。这样 Node 服务、执行 Harness、检查和审核进程及通常的子孙进程从出生起就在同一 Job 中，避开逐个 CLI 启动后的分配竞争。[微软的 Job Object 文档](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)说明最后一个 Job 句柄关闭时会结束关联进程，子进程默认继承 Job，且可禁止 breakaway。guardian 监视启动器进程；启动器正常或异常结束都要终止/等待 Job 清空，guardian 自身崩溃则由内核关闭最后句柄并杀死成员。分配失败、外层 Job 不兼容或退出未确认时停止派工。Node 的 `taskkill` 只作活进程取消路径。非 Windows 平台使用独立进程组并提供等价的退出确认。
2. **写前记录。** 执行、检查、审核、提交前先以事务写入阶段意图、`runId`、attempt、工作树版本、期望的 Harness+Model、绑定版本与唯一进程代号。启动后记录 OS 进程身份、创建时间和监督层身份；单独的 PID 不足以排除复用。一次任务同一时刻只能有一个 writer lease。
3. **启动协调。** 数据目录只能有一个活动 Zero 服务实例。正常退出时 guardian 在释放单实例 mutex 前保留 Job 句柄并等待 Job 的活动进程数归零。guardian 自身崩溃后，不能假定重新打开具名 Job 一定可行；新实例须用持久化的 PID、进程创建时间及启动代号核对并等待旧进程退出，无法证明整棵旧进程树结束时进入 `recovery_required`。新实例确认旧写入者终止后才运行恢复扫描。不能在旧服务仍运行时直接 `recoverExpired` 并重复派工。
4. **分阶段恢复。** `waiting` 到期后继续使用现有 checkpoint，并重新核对工作树、配置和绑定；`executing` 异常结束后保存只有 Zero 实测事实的降级交接，在同一 worktree 发起新尝试，再运行全部检查；`reviewing` 异常结束后丢弃旧 verdict，重新固定暂存树并审核；提交/归档中断时对照持久化的受审 tree、HEAD、diff 和报告，重复安全步骤。任一进程退出或文件版本无法证明时停在 `recovery_required`。所有恢复路径保留 attempt 历史且不偷偷增加用户设置的返工次数。
5. **启动身份（旧方案）。** Codex 订阅与 ZCode 桌面提供方依赖用户身份、网络和本机配置。当时曾考虑由 Windows Task Scheduler 使用标准账户凭据注册开机任务；该方案与安装脚本现已移除。当前由用户登录后手动启动 Zero，仍须在目标电脑验证 Codex 订阅、代理、ZCode 提供方和工作目录；应用不写入用户现有 ZCode 配置。

## 顺序与验收

1. 先实现监督层与单实例检查，用独立测试进程验证强制结束 Zero 时，模拟 Harness 的子孙进程均停止；包含启动、取消、超时与进程树逃逸测试。
2. 将进程身份和恢复状态加入 SQLite 迁移；实现恢复扫描及人工阻塞解释。故障注入覆盖创建 worktree 后、子进程启动后、检查后、审核后、提交后、DONE 前的崩溃窗口。
3. 把结构化交接作为后续尝试的**不可信背景资料**传入；重新采集 Git 和检查事实。跨模型 GLM → DeepSeek 的多个成功执行阶段使用同一任务 worktree，按确认退出的顺序接力。
4. 最后安装目标电脑的后台启动，并验证实际重启、网络恢复、订阅额度用尽到重置后的自动继续。测试报告应显示原任务 ID、原 worktree、旧进程已停止的证据、新 attempt、路由、检查、审核与最终提交。

在这些验收通过前，Zero 可以自动恢复已确认停止的额度等待，但不能宣称普通崩溃和无人登录开机已全自动恢复。
