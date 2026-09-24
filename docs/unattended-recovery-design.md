# Zero 无人值守恢复设计

状态：架构决策，2026-09-25。本文区分已实现的额度等待和仍需实现的进程崩溃恢复；不能把测试中的定时重试当作整机重启后的自动接力。

## 当前事实

- `TaskStore.pauseForQuota` 将可信的提供方额度错误写成 `waiting`、重试时间和阶段 checkpoint，释放 lease；调度器每秒尝试领取到期任务。Worker 恢复时核对原 worktree 指纹、路由和检查证据。这条路径已有进程重启单元测试，但尚未观察到真实订阅额度耗尽及五小时重置。
- 普通 lease 过期由 `recoverExpired` 归回 `pending` 并中断 attempt/stage。Worker 随后看到已有 worktree 或中断 attempt 会拒绝继续，任务会失败。这保护了文件，但尚未满足无人值守的崩溃恢复。
- `runProcess` 在父进程活着时可用 `taskkill /T /F` 停止 Windows 子进程；若 Zero 自身突然退出，这段清理代码不能执行。stage 的 `processStartId` 是 UUID，不是可供新进程证明旧子进程已结束的 OS 身份。
- 仓库已有 Windows Task Scheduler 安装脚本，可用标准用户账户及密码注册开机启动；目标电脑尚未完成安装后重启、订阅凭据和代理的实测。服务仍没有跨进程单实例锁或能确认旧子进程退出的监督层。

## 决定

Zero 的恢复以**先确认旧写入者停止，再核对工作树，再续接阶段**为硬门槛。恢复器不能仅凭 lease 到期、PID 不存在或报告文件存在就断言任务安全。SQLite 是状态权威，Git tree/index/工作树是文件权威；两者不一致时进入可诊断的 `recovery_required` 状态，而不是把任务送回普通 `pending`。

1. **进程包含。** Windows 采用随 Zero 一起打包的轻量原生 guardian：它在 Job 外持有非继承的 Job 句柄和数据目录单实例 mutex，先以 `CREATE_SUSPENDED` 创建现有启动器，再将其加入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 且不允许 breakaway 的 Job，最后恢复线程。这样 Node 服务、执行 Harness、检查和审核进程及通常的子孙进程从出生起就在同一 Job 中，避开逐个 CLI 启动后的分配竞争。[微软的 Job Object 文档](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)说明最后一个 Job 句柄关闭时会结束关联进程，子进程默认继承 Job，且可禁止 breakaway。guardian 监视启动器进程；启动器正常或异常结束都要终止/等待 Job 清空，guardian 自身崩溃则由内核关闭最后句柄并杀死成员。分配失败、外层 Job 不兼容或退出未确认时停止派工。Node 的 `taskkill` 只作活进程取消路径。非 Windows 平台使用独立进程组并提供等价的退出确认。
2. **写前记录。** 执行、检查、审核、提交前先以事务写入阶段意图、`runId`、attempt、工作树版本、期望的 Harness+Model、绑定版本与唯一进程代号。启动后记录 OS 进程身份、创建时间和监督层身份；单独的 PID 不足以排除复用。一次任务同一时刻只能有一个 writer lease。
3. **启动协调。** 数据目录只能有一个活动 Zero 服务实例。正常退出时 guardian 在释放单实例 mutex 前保留 Job 句柄并等待 Job 的活动进程数归零。guardian 自身崩溃后，不能假定重新打开具名 Job 一定可行；新实例须用持久化的 PID、进程创建时间及启动代号核对并等待旧进程退出，无法证明整棵旧进程树结束时进入 `recovery_required`。新实例确认旧写入者终止后才运行恢复扫描。不能在旧服务仍运行时直接 `recoverExpired` 并重复派工。
4. **分阶段恢复。** `waiting` 到期后继续使用现有 checkpoint，并重新核对工作树、配置和绑定；`executing` 异常结束后保存只有 Zero 实测事实的降级交接，在同一 worktree 发起新尝试，再运行全部检查；`reviewing` 异常结束后丢弃旧 verdict，重新固定暂存树并审核；提交/归档中断时对照持久化的受审 tree、HEAD、diff 和报告，重复安全步骤。任一进程退出或文件版本无法证明时停在 `recovery_required`。所有恢复路径保留 attempt 历史且不偷偷增加用户设置的返工次数。
5. **启动身份。** Codex 订阅与 ZCode 桌面提供方依赖用户身份、网络和本机配置。Windows Task Scheduler 的 `InteractiveToken` 需要用户已登录；`S4U` 不保存密码，但[微软文档明确其无法访问网络或加密文件](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element)，不适合作为这里的默认方案。现有安装脚本采用标准用户账户与密码注册开机启动；仍须在目标电脑验证 Codex 订阅、代理、ZCode 提供方和工作目录。安装器应保持任务定义可检查，由用户授权后才注册系统任务；应用不写入用户现有 ZCode 配置。

## 顺序与验收

1. 先实现监督层与单实例检查，用独立测试进程验证强制结束 Zero 时，模拟 Harness 的子孙进程均停止；包含启动、取消、超时与进程树逃逸测试。
2. 将进程身份和恢复状态加入 SQLite 迁移；实现恢复扫描及人工阻塞解释。故障注入覆盖创建 worktree 后、子进程启动后、检查后、审核后、提交后、DONE 前的崩溃窗口。
3. 把结构化交接作为后续尝试的**不可信背景资料**传入；重新采集 Git 和检查事实。跨模型 GLM → DeepSeek 的多个成功执行阶段使用同一任务 worktree，按确认退出的顺序接力。
4. 最后安装目标电脑的后台启动，并验证实际重启、网络恢复、订阅额度用尽到重置后的自动继续。测试报告应显示原任务 ID、原 worktree、旧进程已停止的证据、新 attempt、路由、检查、审核与最终提交。

在这些验收通过前，Zero 可以自动恢复已确认停止的额度等待，但不能宣称普通崩溃和无人登录开机已全自动恢复。
