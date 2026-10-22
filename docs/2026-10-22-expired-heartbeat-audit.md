# 2026-10-22：过期租约不能通过迟到心跳恢复执行权限

## 问题与修复

`TaskStore.heartbeat` 原先只验证 owner 和任务状态。电脑休眠、事件循环长时间停顿或心跳迟到后，只要恢复扫描尚未先执行，同一 owner 就可以续活已经到期的租约。现有阶段授权与 worker 断言会拒绝到期租约，因此这次续活会绕过既有的恢复检查边界。

独立基线控制先在到期后启动阶段，得到 expired lease 拒绝；随后同 owner 的 heartbeat 返回 true，同阶段立即可以启动，恢复扫描返回空。这证明可达的授权不一致；没有据此声称生产环境发生过双 writer。

修复在原子 heartbeat UPDATE 中要求数据库内的原到期时间严格晚于传入的当前时间。到期瞬间和之后均拒绝续租，保留原截止时间与历史事件，让 worker 进入已有的 leaseLost/停止路径，再由恢复扫描隔离和记录中断证据。正常活跃租约、取消期间仍有效的心跳和后续专门恢复流程保留原有语义。

## 验证

- 新 Store 回归共 9 项：running/reviewing/revision 各自覆盖截止时刻、截止之后、截止之前正常续租及错误 owner。旧代码为 6 失败、3 正常对照通过；修复后 9 项通过。
- 新 worker 回归使用真实项目内 Git 工作树和本地假 adapter。只推进 Date 时钟越过原截止时间，保留实际心跳 timer；旧代码不会取消 writer，控制在等待取消处失败。修复后取消当前 writer，检查、复审、commit/report 操作均未启动；恢复扫描保留 interrupted stage/attempt 和 recovery_required 状态。它没有调用真实供应商或证明操作系统真的休眠。
- 上述 10 项新回归连同现有 12 项持久取消及 5 项阶段接力回归，27/27 通过，实际退出码 0；TypeScript 编译通过。
- 额外影响范围回归覆盖完整 `task-store`、`worker`、`worker-review-cancel`、`worker-rework-stages-quota` 四个测试文件：144/144 通过，实际退出码 0，2026-10-22 23:38（北京时间）结束。它覆盖任务接力、额度等待、恢复、取消及最终提交边界；不是完整核心测试套件。
- 首轮相同范围为 126 通过、18 失败，失败记录均含本地 HTTP 连接 `EACCES 127.0.0.1`。获得相应执行权限后先单独复核真实本地 Codex 取消控制通过，再重跑上述四文件得到 144/144。原失败日志未覆盖或删除，未通过改断言使其变绿。
- Astra high 仅复核此关键租约/恢复授权变更，结论 APPROVE；独立新编译退出 0，独立定向验证 9 项及续租正控制 3 项均通过。复核记录同时明确假 adapter 的配合取消不等于证明所有真实供应商的进程树终止，review-recovery 的心跳路径为静态检查。

证据位于 `data/verification/lease-heartbeat-audit/`。worker 控制最初的 fixture 未配置验证命令，启动前即失败；修正 fixture 后才取得这里记录的旧版取消超时证据。没有把 fixture 错误当作产品缺陷。

本轮另有桌面任务详情迟到请求检查：取消成功/失败与目标重新验收失败后切换详情的 3 项控制均通过，未据此修改前端；其证据位于 `data/verification/desktop-action-next-audit/`。

## 发布状态

记录本文件时 GitHub 发布仍未成功：最近实际 push 无法连接 github.com:443，项目内没有可用认证。此前六个提交仅在本地 main。不得把本轮本地提交或本地 main 更新表述为已发布；远端发布必须另有成功推送及 SHA 核实回执。
