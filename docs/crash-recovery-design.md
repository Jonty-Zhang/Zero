# 普通崩溃后的安全恢复

## 当前边界

Zero 的额度等待有明确的完成边界：适配器返回已分类的额度信号，worker 等待调用进程退出，记录阶段输出指纹、交接和检查点，然后释放租约。重试时重新核对 worktree。这不能作为服务崩溃恢复的证据；崩溃时可能仍有子进程写入，执行、测试或审核也可能只完成了一部分。

原生 Windows guardian 为同一用户和数据目录持有命名互斥锁，继任实例在启动 Zero 前等待上一代命名 Job 的活动进程清零。它现在把启动代际、lock ID 和 predecessor-drained 断言传给 Node；Node 按安装脚本相同的路径规范化规则计算 `ZERO_DATA_DIR` 的 SHA-256，只有 lock ID 完全匹配才将这项断言写入 SQLite。SQLite 保存每次启动代际、任务领取代际和阶段开始代际。旧数据库通过新增表和可空列迁移，旧记录的代际保持 NULL。

只有 guardian 在持有同用户、同 lock ID 的命名互斥锁后，完成旧命名 Job 查询且确认 ActiveProcesses 为零（或确认 Job 不存在）时，才会设置 `PREDECESSOR_DRAINED=1`。它随后在本会话的命名映射中记录启动代际、guardian 和直属子进程的 PID 与创建时间；直属子进程先加入新 Job，再开始运行。Node 通过随包 guardian.exe 的 `--verify-startup` 核对自身正是该代直属子进程，且仍属于新 Job。lock ID 不匹配、映射或进程证据缺失、超时或 helper 不可用时，启动证据记为 `guardian_startup_unverified`，`predecessor_drained` 不置真。

直属子进程核验是恢复判断的基础证据，不是对同一账户恶意篡改或仿造命名对象的密码学证明：同账户程序仍可影响本地安装和 SQLite。新证据类型为 `guardian_startup_verified`；历史 `guardian_env_assertion` 和旧 `member_verified` 列保持可读，但不能建立可恢复的前代关联。没有 guardian 环境、字段不完整或 lock ID 不匹配时，Node 持久化 `unguarded`、`invalid_attestation` 或 `rejected_lock_id`。当前已实现的有限恢复要求本代证明精确关联到紧邻前代，并由 guardian 在启动前确认前代 Job 已清空；租约过期、PID 或代际字段都不能单独授权接管已有 worktree。该机制尚未在目标机器安装或完成开机及强制中断实机验收。实现与限制见[原生 guardian 说明](../native/windows-guardian/README.md)。

## 必须保持的约束

1. 每个任务同一时间至多有一个写入者。租约过期只是数据库中的时间事实，不是操作系统中的进程退出证明。
2. 不确定的工作应进入可见的 `recovery_required` 状态，保留任务、尝试、阶段、worktree 和错误证据；不能短暂变为可领取的 `pending`。
3. 恢复必须使用原任务 ID 和原 worktree。新的执行写入必须有新的尝试记录；旧模型输出不能当作已完成工作。
4. 审核结论只对审核时的准确 Git tree、diff 和检查证据有效。崩溃后不能凭报告文件或已有 commit 直接标记 `done`。
5. 没有足够证据时停在 `recovery_required`，向用户展示原因。不能为了无人值守而猜测进程状态或重放可能有副作用的步骤。

## 分阶段实施

### 1. 失效租约隔离

服务启动和运行中周期性检查过期租约。通过 SQLite 事务把活动任务移入 `recovery_required`，把仍在运行的尝试和阶段标为中断，保存原因及事件。`claimNext` 永远不领取该状态。迁移只增加状态/字段，保留已有 SQLite 任务。此阶段已由本地测试与公开 CI 覆盖，解决“启动时租约尚未过期，随后永远卡在 running”的问题，并阻止旧 worktree 被第二个 writer 自动接管。

对于当前协议版本领取、尚无创建意图、尝试、阶段、路由、检查或审核记录的任务，worker 在确认任务 worktree 路径不存在后，可通过专用数据库事务把同一任务重新排队。旧版本在升级前领取的任务没有本协议标记，仍保持 `recovery_required`；因为旧 worker 可能已开始 `git worktree add` 却未记录意图。这条自动路径只覆盖写入前窗口，不能推广到已有工作区或执行进程。

创建 worktree 前，Zero 现在先准备并保存仓库、Git common dir、目标路径、分支和基点；调用 `git worktree add` 前重新核对这些值，成功后记录观察到的 HEAD、common dir 和工作树指纹。创建命令或创建后观测失败时保留意图并进入 `recovery_required`，不自动删除可能已经注册的路径/分支。这是阶段日志的第一步，仍不能独自证明旧进程停止。

### 2. 进程树停止证明

已实现：guardian 在启动服务前等待旧命名 Job 活动进程数归零；启动代际、Node 的直属子进程核验结果关联到任务领取和阶段开始记录，并能证明当前启动代与紧邻前代的关系。有限的普通崩溃恢复只在该证据完整时开放。仅凭 PID 不存在、租约超时或互斥锁可获取，均不足以证明旧写入者停止。若未由 guardian 承载或 lineage 证明丢失，保持 `recovery_required`。

### 3. 阶段重入

已实现迭代 A 的受限范围：对状态为 `running`、revision 为 0、最多一个 execution stage，且尚无 review/commit/report 证据的任务，在旧 Job 清空后核验数据库中的 worktree 创建记录、repo/common dir/path/branch/base/HEAD、Git worktree 注册和 allowed paths，再重测 fingerprint。事务取得新 lease 后会再次核对身份，然后从新的 route 和 execution attempt 开始；执行完成后所有配置检查及 Codex review 都会重跑。旧 route、检查、交接和模型输出只保留作历史背景，旧审核不会被接管。检测到身份或路径不匹配、commit/审核边界、缺少证据或多阶段/返工状态时，继续停在 `recovery_required`。反复崩溃时，每一代必须指向并证明其紧邻前代已清空。

此范围仍不恢复旧 Harness session，也不保证外部副作用可撤销或去重。Git-based fingerprint 不纳入被 Git 忽略的 build/cache 文件；它们可能在同一 worktree 中残留并影响恢复后的执行/检查，但不会作为审阅 diff 的文件证据。需要可复现的检查，并避免依赖本地隐藏缓存才能通过。

### 4. 审核与提交重放

仍待实现的迭代 B：持久保存审核对应的 Git tree、diff 指纹、检查配置及结果、审核尝试 ID。提交前保存意图及 pre-HEAD；重启时只在数据库证据与 Git 当前状态精确匹配时幂等完成。当前对已开始 review 或出现本地 commit/report 窗口的普通崩溃不作自动重放；报告是产物，不是任务状态权威；`done` 只由数据库事务在已验证提交和报告后写入。

## 验收顺序

- 用假适配器在上述各个边界注入崩溃，重开 TaskStore，确认不出现第二写入者或错误的 `done`。
- 覆盖服务在租约到期**之前**重启、随后租约到期的场景，确认运行中的周期检查会处理。
- 用可控 guardian 证据分别测试“旧进程树仍在”“已确认停止”“证据丢失”。
- 迭代 A 已包含自动化测试；仍需在目标机器验证手动启动、guardian 故障恢复、网络/订阅恢复和实际模型任务。Zero 不会在 Windows 开机时自动启动；用户重新启动 launcher 后才会进入恢复扫描。未完成实机验收前，不能声称目标设备已实现全流程崩溃恢复。
