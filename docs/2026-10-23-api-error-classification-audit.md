# 2026-10-23：API 永久账户错误与重试时间

## 问题与复现

API coordinator 原先丢弃 HTTP 429 响应体，将所有 429 都转为可恢复的配额等待。结构化错误中的 `insufficient_quota` 等账户错误因此与核心 CLI 分类规则不一致，router 会等待并自动重试需要用户处理的账户问题。

另一个独立问题是异常大的有限数值 `Retry-After`：数值计算仍有限，但超出 JavaScript Date 可表示范围，`toISOString()` 抛出 RangeError，使请求无法返回正常的执行结果。

本地注入 fetch 基线确认两项行为，正常限流与 401 认证失败对照保持正常；未调用供应商。基线退出 0 表示验证了旧版错误行为。新增七项契约控制在旧版编译成功后为 2 通过、5 失败，实际退出 1；编写 fixture 时两次类型检查错误单独保留，没有计为产品失败。

## 改动

抽取核心现有的永久账户错误判据，保持 CLI 分类语义。429 响应使用既有字节上限读取，只检查结构化 `error.code/type/message` 字符串，不信任无关 metadata、模型内容或任意嵌套字段。识别永久账户错误时返回固定普通失败及 HTTP 429，不附加 quota，也不回显提供方原始内容。

正常限流、空体、坏 JSON、读取失败或超限且没有可信账户证据时保留 HTTP 429 的恢复语义。读取中的取消或超时优先返回对应终态，不能退回配额等待。新的响应体读取仍受同一请求超时约束。

重试时间先检查 Date 是否有效再格式化。只有取得有效时间才标记 `retry_after`；无效或越界时间使用既有 `fallback`，不抛异常。

## 验证

- 编译实际退出 0；core quota 和全部 router/API/reviewer 测试 35/35 通过，实际退出 0。
- 新增控制覆盖四种账户 code/type、账户 message、正常/空/坏 JSON/无关字段、401、异常及正常重试时间、超限响应取消、429 读取取消和超时，以及真实 router 普通失败与 QuotaLimitError 的区别。
- Worker 的实际 API 取消、复审取消和多 agent 返工配额恢复集成共 26/26 通过，实际退出 0；包括真实本地子进程取消、SQLite 终态、guardian 重启恢复、历史 Git/report 保留和不重放已完成 planner。
- 普通独立最终复核 APPROVE：独立编译退出 0、新增七项控制通过，另有八项边界控制通过。真实本地 HTTP 429 持有响应体时，取消与超时均在 fixture cleanup 前关闭 response/socket，且没有 quota；正常限流和账户错误正反对照通过。UTF-8 字节边界和不可信 error envelope 也符合预期。未使用 Astra 处理本轮分类修复。

证据在 `data/verification/api-error-next-audit/`。本轮没有修改重试策略或进程终止机制。

## 发布

依用户要求暂缓 GitHub。本地提交与 main 更新不表示已推送。
