# 2026-10-23：CLI 准备期间取消和截止时间不得失效

## 已复现的问题

BaseHarnessAdapter 原先在完成异步 probe 和 prepare 之后才登记取消 controller。DSH 的 prepare 会再次执行实际 CLI 配置检查；此时取消找不到活动请求，检查结束后仍会启动新 writer。显式 deadline 也只在 prepare 之前检查，准备期间过期后仍可启动执行。Codex 和隔离 CLI ZCode 同样经过这个共享基类。

独立控制使用真实 DshAdapter、项目内假 CLI 和配置检查门控，未调用供应商。旧版取消后 91 ms 启动 writer、截止时间到期后 199 ms 启动 writer，两次均返回 completed；正常对照成功。该控制的实际退出 0 表示它验证了这些旧版错误行为，不表示旧版满足预期。

共享 runProcess 也先打开异步 lifecycle trace，再启动进程，最后才处理已经取消的 signal。因而仅在上层 prepare 后检查取消还不够：等待 trace 文件时仍可能收到取消。

## 修复

基类在第一个异步 probe 之前按 task/attempt 登记 controller，拒绝同一活动 attempt 的第二次运行，并在整个 run 的 finally 中只清理本次拥有的 controller。probe 和 prepare 返回后均先检查取消，不再启动后续准备或 writer；无关任务和相邻 attempt 保持独立。

prepare 之后重新检查显式 deadline，并把绝对时间传给共享启动器。启动器在异步 trace 前后检查取消和到期；如果无需启动就关闭已打开的 trace。真正启动时仅使用绝对 deadline 的剩余预算，不能因为准备耗时又得到完整的执行时间。没有显式 deadline 的既有相对 timeout 语义保留。

本轮没有据静态推测修改进程树终止机制，也没有宣称取消会立即中断所有配置检查。取消后的配置检查可能结束，但不得再启动 writer。

## 验证记录

- 新基线控制共 7 项，旧版 6 失败、1 正常对照通过，实际退出 1。失败覆盖 probe/prepare 取消、重复 attempt、准备期间 deadline 到期，以及启动器进入前/trace 等待期间取消。只有本地 Node marker writer 和注入的禁止启动探针。
- 修复后准备期控制与完整 process-runner 文件 24/24 通过，实际退出 0；新 deadline 控制还覆盖 trace 前后到期和只剩 500 ms 时的执行预算。
- 独立真实 DSH 控制用同一冻结脚本及假 CLI 新编译后通过，实际退出 0：普通请求 completed，准备期取消 cancelled，准备期过期 timed_out，后两者均没有 writer marker。脚本和假 CLI hash 与基线一致。
- 影响范围回归覆盖全部 adapter 测试、router/API 测试以及 worker-review-cancel、worker-heartbeat、worker-api-route-cancel，共 16 个文件；196/196 通过，实际退出 0，2026-10-23 01:52（北京时间）结束。包括真实本地 Codex 进程树取消、持久取消、重启恢复、接力和旧协议控制；不是完整核心套件。

关键启动边界由 Astra high 独立复核，最终结论 APPROVE。独立编译、准备期 5 项、启动器 10 项和 controller 异常清理及 ID 隔离 4 项均通过；五个改动源匹配冻结 hash，九个模块匹配独立编译产物。

真实 Worker 补充控制使用 SQLite、Git worktree、DshAdapter 和假 CLI，旧版取消后 94 ms 仍启动 writer、implement attempt 为 succeeded；修复后没有 writer，attempt 为 interrupted。两版逻辑 stage 均为 interrupted，任务最终均为 failed/Cancelled；检查、复审、提交、DONE 和第二阶段执行均未发生，SQLite 重开后保持终态。双版本控制实际退出 0，未调用供应商。

证据在 `data/verification/preparation-cancel-root/` 和 `data/verification/dsh-next-audit/`。真实 worker 控制首次因错误地预期旧版已完成 attempt 为 interrupted 而退出 1，原脚本、日志及修正记录均保留；后续版本区分旧版和修复版的实际 attempt 状态，没有改写旧版事实。普通审查的后台 descendant 探索因存在性探测受沙箱限制，没有可靠证据，未计为本次产品缺陷。

## 发布

GitHub 仍依照用户要求暂缓。本轮本地提交与 main 更新均不等同于已推送；远端发布需要另行取得成功 push 及 SHA 核实。
