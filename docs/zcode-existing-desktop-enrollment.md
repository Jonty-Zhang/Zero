# ZCode 现有桌面提供方接入决策

状态：实施与实测记录，2026-09-28。现有 `isolated_config` CLI 绑定仍是 Zero 自己管理的隔离配置；它不能代表用户已经在 ZCode 桌面界面接好的 GLM 和 DeepSeek。

## 身份与边界

每个执行绑定都须包含 `harness=zcode`、Zero 内部模型 ID、ZCode 协议的精确 `providerId/modelId`、可选且独立验证的思考等级、CLI 版本、验证证据。一个 Harness 对应多个模型。配置新增 `app_server_existing_desktop` selector，表示 Zero 启动自己的 app-server 进程、使用现有桌面 profile 的提供方，但不搬运、覆盖或解析桌面凭据/模型默认配置。`isolated_config` 继续作为另一种显式选择，不能悄悄回退到它。

`session/create.settings.model.available[]` 的空会话目录诊断现已成功，但目录本身仍**不作为执行绑定的验证证据**。用户必须在 Zero 本地注册表中明确填写精确的 `providerId/modelId`；显示名、GLM/DeepSeek 字样或当前 ZCode 界面选中项均不能代替这两个 ID。同名模型可能属于不同提供方。一次 nonce 成功只证明向该 tuple 和显式思考等级发出的请求得到响应，不能独立确认实际服务模型或计费来源，所以记录仅为 `selector_only`。目录只公开经过校验的可选思考等级；每个绑定仅允许本次真实验证过的等级。

## 进程与验证

现有桥使用独立 stdio app-server；创建 `persistence: deferred` 会话前，关闭该进程内 AskUserQuestion 自动答复并确认回执。每个 `sendText` 显式携带模型 tuple 与 `modelExecution.selectionScope: execution`、`memoryExtraction: skip`，禁止脱离父回合的后台子 Agent。现有桌面模式只对当前任务 worktree 内经过路径核验的 Edit/Write 给予单次权限；Bash、用户输入、计划审批、未知权限及高风险请求不自动批准。临时 v4 权限事件只在与已批准的请求、会话和工具调用完全匹配并于限定时间内消失时放行。取消只使用与已观测前景执行 ID 绑定的 v4 stop，进程退出必须确认。Zero 在回合结束后关闭 app-server 进程，但不调用会删除产品会话的 `session/close`。因此任务提示词、响应及验证 nonce **可能保留在 ZCode 桌面会话历史中**；`deferred` 不能作为不留痕的保证。此路径不应写用户模型默认值或配置文件。

上述权限门不等于操作系统沙盒。ZCode 子进程仍以启动 Zero 的用户身份运行；worktree 和单次写入路径核验不能证明只读工具无法访问该用户可读的其他文件。对不可信仓库和高敏感数据，后续还需进程级隔离设计和验证。

接入验证与后续目录诊断分开：

1. **当前命令：nonce 绑定。** 只对用户在 Zero 注册表中明确填写的 tuple 和可选思考等级，在一次性 worktree 发出唯一 nonce；要求本轮收到成功的终止事件、回复与 nonce 完全相等、app-server 已停止、验证前后 CLI 版本一致。结果仅记为 `selector_only`，只启用本次验证过的思考等级。失败不改原绑定，不使 Router 看到候选。
2. **目录诊断。** 在一次性 Zero worktree 创建空的 deferred session，仅汇总提供方 ID、模型 ID 和支持的思考等级，不输出配置、凭据、代理或完整 app-server 日志。若订阅 ACK、初始快照或目录不可用，按固定类别报告失败并停止；不猜测模型。即使目录可用，还需找到实际回合模型的独立证据，才能提高绑定的证据等级。

`ZCodeAdapter` 可按绑定 selector 分发给隔离 CLI 路径和 app-server 路径；Zero 配置存储负责原子化写入**自己的**绑定记录与版本钉住的验证证据。Router 的候选只来自已验证且启动探测健康的组合。任务手动锁定 Harness、模型、思考强度时仍需经过同一验证门；未锁定的字段才交 Codex 分配器选择。Codex 分配和审核保持用户要求的固定角色。

## 当前实测与下一步

本机 0.16.9 的 GUI 安装把 CLI 放在 `resources/glm`、内置 Provider 文件放在兄弟目录 `resources/config/provider`；CLI 自身的两个默认候选路径没有覆盖这个布局，导致它在协议握手前以退出码 1 结束。Zero 现在只在发现该随安装包提供的文件时，向独立子进程传入内置文件和对应 profile 的个人 Provider 文件路径，不读取或复制配置内容。隔离模式还须给 Windows 的 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME` 提供 Zero 自有的有效目录；空值会使 ZCode 的 `uv_os_homedir` 初始化失败。修复后，隔离 profile 完成偏好回执和空会话创建；现有桌面 profile 的无模型诊断也完成空会话创建，返回 4 项可用模型，诊断前后个人 Provider 文件哈希一致。

2026-09-28 的目录返回了 GLM 与 DeepSeek 的 API 提供方模型，及其可选思考等级。首次真实绑定因未显式传思考等级而失败；修复后又发现合法的空增量帧会推进会话序号，Zero 原先错误地拒绝了它。按本地 ZCode 协议实现修复并通过模拟协议测试后，三组独立的 API 模型绑定完成了本机 nonce 回合验证，包括 GLM Flash、DeepSeek Flash 和 DeepSeek Pro；证据分别保存于忽略的 Zero 本地数据目录，未放入公共仓库。当前 Start Plan 的精确提供方 tuple 没有出现在目录中，因此**没有验证或启用 Start Plan**。这些 nonce 不能证明服务端实际模型身份或计费来源。

同日，本机隔离的 Windows 发布目录完成了 GLM Flash 的真实任务验收：Codex 分配、ZCode 编辑、Zero 检查、Codex 独立审核、结果提交和报告全部通过，任务到达 `done`。随后 `f9a4148` 的 CI 安装包通过清单验证并更新到目标电脑，正式安装版也完成了同一流程。首次安装版尝试在正确写入后失败，其原因尚未定位；独立诊断和同提示词重试成功，失败记录保留，不能据此声称偶发问题已解决。验收前后个人 Provider 文件哈希一致，精确 provider/model 标识和运行证据只存于 Zero 本地数据。详见[真实任务验证记录](live-validation.md)。

验收测试须覆盖目录缺失/重复/禁用、同名不同提供方、思考等级不支持、错误 nonce、超时、额度失败、反向权限请求、进程退出不确定、版本变化、旧绑定保留、Router 在验证前后候选变化、两个 ZCode 模型在同一任务 worktree 串行接力。
