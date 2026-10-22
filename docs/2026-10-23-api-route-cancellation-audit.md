# 2026-10-23：取消实际 API 路由请求并保留正确来源

## 问题与修复

运行时支持 API 分配器，但 worker 的路由阶段原先始终把当前 adapter 和 attempt 来源当作 Codex；路由调用没有收到取消信号，API coordinator 也没有按 attempt 取消请求的能力。用户取消或租约到期时，真实 API 请求仍会等待响应或原有超时。读取响应正文期间的超时还会被记成普通的响应读取失败。

现在 worker 把当前取消信号传给 router，router 在调用前报告实际分配器，并在取消时停止该 task/attempt 的请求。API coordinator 在任何异步准备之前登记独立 AbortController，将显式取消和原有超时同时传给 fetch，覆盖等待响应头和读取正文两阶段；结束后清除登记，取消一个请求不会影响相邻请求。router 在准备结束、调用之前及调用之后检查取消，阻止取消期间启动新调用或接受迟到的成功、额度结果。

路由 attempt 结束时记录实际 harness、model 和 reasoning effort，取消或失去租约记为 interrupted。相应的 review rework 路由额度暂停和恢复只接受 Codex 与 api-coordinator 两种已支持来源，保留原有 lease、generation、阶段、工作树身份及恢复链检查。独立 Codex 复审的来源约束没有放宽。

## 可复现证据与验证

- 原实现的新 API 响应头/正文取消控制为 0/2，实际退出码 1；真实 router、API adapter 与本地 Git 工作树构成的 worker 用户取消/租约失效控制也是 0/2，实际退出码 1。失败均发生在等待实际请求收到 abort 处。
- 独立旧版控制确认：caller 已取消后，请求信号仍未取消；释放响应后，路由仍可成功返回。正文超时原先返回 failed，而响应头超时返回 timed_out。
- 两个 Store 路由来源约束的旧版控制为 3 通过、2 失败：Codex 正常对照及未知来源拒绝通过，API 暂停与已保存 API 暂停恢复失败。修复后独立新编译退出 0，5 项定向控制及完整 task-store 文件 83/83 通过，实际退出码 0。
- 根目录新编译及 27 项路由、API、worker 定向回归通过，实际退出码 0。覆盖异步 schema/probe 准备时取消、响应头与正文取消/超时、错误 task 不得取消、相邻 attempt 正常完成、结束后不再可取消，以及用户取消和租约到期时不启动 writer。
- 独立真实本地 HTTP 控制通过，实际退出码 0：未发响应头时取消，5 ms 内观察到服务端 response 和 socket 关闭；只写入部分正文时取消，1 ms 内关闭。两项均未手动释放响应或等待 10 秒超时，断言早于 fixture 清理；正常 API 路由对照成功。只连接 127.0.0.1，使用已知假密钥，没有调用真实供应商。

- Astra high 仅用于本次取消与恢复授权关键链，最终结论 APPROVE。独立新编译退出 0，API/worker 12/12、Store 5/5 通过；额外 8 项控制确认取消前启动边界、listener 清理、拒绝迟到的成功/额度结果及重复取消安全。真实 API adapter/router 的 429 经真实来源记录、SQLite 双 guardian 世代重启后恢复控制 1/1 通过，实际退出码 0；错误工作树身份与重复 claim 仍被拒绝。该集成使用 Store 既有 fixture 身份事实，没有声称完整 rework worker/provider 端到端执行。

- 影响范围长回归覆盖 task-store、worker、worker-review-cancel、worker-rework-stages-quota、worker-api-route-cancel、task-cancellation、handoff-store、worker-heartbeat、task-heartbeat、server/cancel-report 十个文件，181/181 通过，实际退出码 0，于 2026-10-23 01:34（北京时间）结束。它覆盖任务接力、额度恢复、持久取消、提交和报告边界，不是完整核心套件。
- 提交前核对全部复核证据 hash，八个相关生产/测试模块当前源码与复核清单一致，根目录编译产物与独立编译产物逐字节一致。长回归日志与真实完成回执均已核对并保存 hash，没有用观察超时或单条通过替代最终退出码。

证据保存在 `data/verification/api-route-cancel-audit/`。首个新 fixture 的清理回调重复释放响应造成一次 7 通过、1 失败，修正清理后才完成后续验证，原日志保留；它不是产品缺陷。关键复核的补充控制首次 8 通过、1 失败，是 reviewer 错将既有身份检查的 throw 预期为 undefined；改为断言抛错后该项通过，未修改生产或项目测试，原退出 1 记录保留。真实本地 HTTP 首次连接被沙箱以 EACCES 拒绝，在获得仅限该本地 fixture 的执行权限后原控制通过，同样没有计为产品缺陷。连接关闭证明本地传输被取消，不保证远端供应商的计算一定停止。

## 发布状态

用户已要求暂缓 GitHub，继续本地改进。本轮提交与本地 main 更新需要独立记录，不代表已推送；远端发布必须另有成功 push 和远端 SHA 核实。
