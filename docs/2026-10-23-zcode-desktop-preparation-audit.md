# 2026-10-23：ZCode 桌面模式准备期取消

## 问题

ZCode 的 existing-desktop 适配器有独立的 run 流程，不经过共享 CLI 基类。此前它在 await version/help probe 后才登记 controller：准备期间取消查不到请求，之后仍会启动 app-server。同一 attempt 在准备期间也能被第二次调用抢先启动。

取消键原先以冒号拼接 taskId 和 attemptId，带冒号的相邻身份组合会命中同一个键，从而取消另一个请求。

本地注入 probe/peer 基线确认准备期取消后仍调用 launchPeer，没有启动真实 CLI 或供应商请求。五项新契约控制在旧版为 4 失败、1 正常清理对照通过，实际退出 1；失败覆盖 version/help 取消、准备期间重复启动和身份组合隔离。

## 修复

外层 run 在任何异步准备前按 JSON 元组保留本次 controller，并拒绝同一活动 attempt。完整 run 的 finally 只移除自己拥有的 controller，包括验证和 probe 的提前返回。probe 返回后优先检查取消，再处理可用性或版本错误。

保留既有执行超时起点、deadline 校验、协议会话及关闭流程。准备探测可以完成，但取消后不会再启动 app-server。本轮没有修改 peer 底层启动/进程树终止机制。

## 验证

- 编译实际退出 0，完整 desktop adapter 与 composite 测试 24/24 通过，实际退出 0。
- 六个 ZCode 适配器、协议及 peer/进程树测试文件共 77/77 通过，实际退出 0，包括真实本地测试进程树控制。本轮不是完整核心套件。
- 普通独立双版本控制确认：旧版准备期取消仍 launch/send 一次、重复 attempt 会 launch 两次、含冒号的身份组合会互相影响；修复版取消后 launch/send 均为零、重复启动被拒绝、相邻身份保持独立，正常和结束后重试也通过。两版实际退出均为 0，分别断言旧行为与修复契约；全部使用注入 probe/peer，没有真实供应商请求。首次误选修复版产物执行旧行为断言的退出 1 留存为 fixture 版本选择错误。
- Astra high 对关键启动取消边界独立复核为 APPROVE：独立编译、八项定向控制与四项补充控制均实际退出 0，覆盖 probe 失败/抛错时取消优先、launch 异常清理、身份复用和相对 timeout 起点。两个改动源匹配冻结值，独立编译与已测试的 root dist 两个模块逐字节相同。

证据：`data/verification/zcode-preparation-next-audit/`。GitHub 依用户要求暂缓，本地提交不等于远端发布。
