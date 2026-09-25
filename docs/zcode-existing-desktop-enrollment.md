# ZCode 现有桌面提供方接入决策

状态：实施设计，2026-09-25。现有 `isolated_config` CLI 绑定仍是 Zero 自己管理的隔离配置；它不能代表用户已经在 ZCode 桌面界面接好的 GLM 和 DeepSeek。

## 身份与边界

每个执行绑定都须包含 `harness=zcode`、Zero 内部模型 ID、ZCode 协议的精确 `providerId/modelId`、可选且独立验证的思考等级、CLI 版本、验证证据。一个 Harness 对应多个模型。配置新增 `app_server_existing_desktop` selector，表示 Zero 启动自己的 app-server 进程、使用现有桌面 profile 的提供方，但不搬运、覆盖或解析桌面凭据/模型默认配置。`isolated_config` 继续作为另一种显式选择，不能悄悄回退到它。

从 `session/create.settings.model.available[]` 读取目录的诊断仍未成功，因此当前命令**不以目录为验证证据**。用户必须在 Zero 本地注册表中明确填写精确的 `providerId/modelId`；显示名、GLM/DeepSeek 字样或当前 ZCode 界面选中项均不能代替这两个 ID。同名模型可能属于不同提供方。一次 nonce 成功只证明向该 tuple 发出的请求得到响应，不能独立确认实际服务模型或计费来源，所以记录仅为 `selector_only`。思考等级当前保持禁用，不能从界面选项推断为已验证。

## 进程与验证

现有桥使用独立 stdio app-server；创建 `persistence: deferred` 会话前，关闭该进程内 AskUserQuestion 自动答复并确认回执。每个 `sendText` 显式携带模型 tuple 与 `modelExecution.selectionScope: execution`、`memoryExtraction: skip`，禁止脱离父回合的后台子 Agent。权限和用户输入必须阻塞；取消只使用与已观测前景执行 ID 绑定的 v4 stop，进程退出必须确认。Zero 在回合结束后关闭 app-server 进程，但不调用会删除产品会话的 `session/close`。因此任务提示词、响应及验证 nonce **可能保留在 ZCode 桌面会话历史中**；`deferred` 不能作为不留痕的保证。此路径不应写用户模型默认值或配置文件。

接入验证与后续目录诊断分开：

1. **当前命令：nonce 绑定。** 只对用户在 Zero 注册表中明确填写的 tuple，在一次性 worktree 发出唯一 nonce；要求本轮收到成功的终止事件、回复与 nonce 完全相等、app-server 已停止、验证前后 CLI 版本一致。结果仅记为 `selector_only`，不启用思考等级。失败不改原绑定，不使 Router 看到候选。
2. **后续目录诊断。** 在一次性 Zero worktree 创建空的 deferred session，仅汇总提供方 ID、模型 ID、禁用状态和支持的思考等级，不输出配置、凭据、代理或完整 app-server 日志。若订阅 ACK、初始快照或目录不可用，记录阶段、RPC 错误码、耗时与有限元数据后停止；不猜测模型。即使目录可用，还需找到实际回合模型的独立证据，才能提高绑定的证据等级。

`ZCodeAdapter` 可按绑定 selector 分发给隔离 CLI 路径和 app-server 路径；Zero 配置存储负责原子化写入**自己的**绑定记录与版本钉住的验证证据。Router 的候选只来自已验证且启动探测健康的组合。任务手动锁定 Harness、模型、思考强度时仍需经过同一验证门；未锁定的字段才交 Codex 分配器选择。Codex 分配和审核保持用户要求的固定角色。

## 当前实测与下一步

本机 0.16.9 的空会话目录探测没有得到 session snapshot；现有记录只证明请求在返回前失败、进程正常退出、没有模型请求，**不能**区分偏好回执、会话创建或目录初始化哪一步出错。当前 nonce 绑定命令和适配器仅经过 fake peer 测试，本机尚无成功的真实绑定。用户指定的 Start Plan GLM-5.3-Flash 因精确提供方 tuple 未确认而不调用；按用户要求，直接调用不可用时保留手动转发。后续逐个验证 ZCode 的其他 GLM/DeepSeek 组合，不共用一个模型的 nonce 证据。

验收测试须覆盖目录缺失/重复/禁用、同名不同提供方、思考等级不支持、错误 nonce、超时、额度失败、反向权限请求、进程退出不确定、版本变化、旧绑定保留、Router 在验证前后候选变化、两个 ZCode 模型在同一任务 worktree 串行接力。
