# Zero Web UI

独立 React + TypeScript + Vite 前端。开发模式通过 Vite 将 `/api` 代理到 `http://127.0.0.1:4179`；生产环境由 Zero 服务托管静态构建目录。

```sh
npm install
npm run dev
npm test
npm run build
```

## 任务工作台

默认列表同时展示任务、状态、当前执行 Agent、仓库和更新时间，可切换为看板。关键词搜索与状态、仓库、Harness 筛选组合生效。概览数字统计全部已加载任务；筛选区下方显示当前结果数量。

任务详情按实际阶段顺序展示执行组合、状态和 HandoffV1 摘要，包括完成项、风险、下一步、变更文件和工作树指纹。提交表单可为阶段填写独立目标并排序。交接中的 `executorSummary` 按纯文本显示并注明是执行者自述；它是模型的主张，Git 和检查结果由 Zero 独立采集。没有阶段记录的历史任务显示明确空态。交接不表示原生聊天历史已跨 Harness 迁移，也不代表实际服务模型身份已被确认。

检查结果独立于执行尝试显示，包含失败/超时/启动失败状态、耗时和可用输出。任务与目标详情在轮询失败后保留缓存并提示过期。每个资源串行轮询，切换任务和卸载页面时中止旧请求；请求等待上限为 20 秒，覆盖响应体读取。Harness 可用性定期刷新。

任务和序列的基础 Ref 默认使用 `HEAD`。网页提交必须为任务或每个序列步骤提供至少一条检查命令，避免队列接受后因无验证门禁而失败。提交请求进行中禁止关闭表单；设置保存时冻结字段以防新编辑被响应覆盖。敏感任务草稿不会写入浏览器存储。

当序列的全部步骤完成，但目标验收因临时故障显示 `blocked` 时，处理故障后可在目标详情点击“重新验收”。请求排队后会保留原判定和发现，刷新页面或重启服务不会丢失；新的验收仍检查最终 Git 证据，不会重置返工预算。额度等待和进行中的验收不能用此入口绕过。弹窗及详情抽屉限制键盘焦点在内部，提交禁用控件后仍可安全使用 Tab；关闭后返回原入口。

## 测试

`npm test` 运行真实 React 组件与轮询交互回归。仓库根目录运行 `node --test web/tests/api.test.mjs`，验证 JSON 错误、中止和响应体超时；超时测试使用隔离本地 HTTP 服务，不调用模型。Linux 和 Windows CI 同时运行这些测试与前端构建。

## API 契约

前端使用 JSON API。任务列表可直接返回数组，也兼容 `{ "tasks": [] }`。

- `GET /api/capabilities`：返回 `{ harnesses, bindings, allocator, reviewer }`。`harnesses` 项为 `{ id, name, available, reason? }`；`bindings` 项为 `{ harnessId, modelId, modelName?, available, reason?, reasoningEfforts: [{ id, label }] }`。`allocator` 和 `reviewer` 分别包含 `models` 与 `reasoningEfforts` 选项数组。UI 只允许手动选择 `available: true` 且其 Harness 同样可用的组合；思考强度只来自所选已验证 binding。
- `GET /api/tasks`：任务数组或 `{ tasks }`。
- `GET /api/tasks/:id`：任务详情，建议包含 `id`, `status`, `prompt`, `acceptanceCriteria`, `repoPath`, `baseRef`, `createdAt`, `route`, `attempts`, `tests`, `review`, `logs`, `report`, `error`。
- 详情还包含 `executionStages`（原始提交的执行选择）、按顺序记录的 `stages` 和 `handoffs`。阶段提供 `id`、`sequence`、`role`、`status`、`predecessorStageId`、Harness/模型/思考强度、输入输出指纹、时间和错误；交接提供来源 attempt、工作树状态、摘要、完成项、决策、文件、检查、风险和后续步骤。`attempts` 附带 `id`、`stageId`、`role` 与 `exitCode`。旧任务或兼容存储缺少证据时返回空数组，不补造记录。
- `tests[].output` 保留检查错误，并附上可安全读取的 stdout/stderr。日志仅从配置的 artifact 根目录读取，每文件最多 256 KiB；缺失或目录外文件不返回。
- `checkEvidence` 指明 `current`、`historical` 或 `unattributed`，并在可归属时返回 `runId`、`stageId`、`attemptId` 与批次 `status`。`tests` 只展示当前批次结果；过期批次放在 `historicalTests`。旧记录无法确认归属时保留可见，但不作为当前改动已通过的结论。完整性失败独立显示，即使所有用户命令退出 0。
- `POST /api/tasks`：接收 `{ repoPath, baseRef, prompt, acceptanceCriteria, maxRevisions, checkCommands, execution: { harnessId, modelId, reasoningEffort }, executionStages: [{ harnessId, modelId, reasoningEffort }] }`。手动项可为 `null`；`executionStages` 可省略，若提供则需包含 1 到 16 个阶段。`execution` 是任务级默认值，阶段字段会覆盖默认值；服务端会验证每个最终组合均对应当前可用且已验证的绑定，并保留阶段顺序。
- `POST /api/tasks/:id/cancel`：取消 pending 或活跃任务。
- `GET /api/sequences` 与 `GET /api/sequences/:id`：目标及其有序任务步骤，`goalReview` 包含最新验收状态、判定和发现，新的服务还返回 `attemptId`；存在待处理的显式重试时返回 `retryRequestedAt`。
- `POST /api/sequences/:id/goal-review/retry`：JSON 为 `{ "attemptId": "最新 blocked 判定的 ID" }`。202 表示请求已持久化；同一仍有效的 ID 重复提交只排队一次。400 为无效输入，404 为序列不存在，409 为 ID 过期或状态不允许，501 为兼容存储不支持持久请求。失败后刷新目标状态再决定下一步。
- Windows 的 `npm`/`npx` 检查会从已安装命令的标准目录解析 JS 入口，用同目录或 PATH 中的 Node 直接执行；参数不拼接为 shell 字符串。其他 `.cmd`/`.bat` 不会自动启用 shell，需提供明确的可执行程序与 argv。
- 阶段还可包含 `objective?: string`，trim 后为 1–4000 字符；执行者摘要经服务端限长后进入 `handoffs[].executorSummary` 和 `attempts[].summary`。
- `POST /api/tasks` 与 `POST /api/sequences` 支持 `X-Idempotency-Key`（16–128 个 ASCII 字母、数字、下划线或连字符）。同 key 和相同 JSON 内容重放返回原资源及 201，不重复入队；相同 key 更换内容或接口返回 409。网页以 payload 摘要和随机 key 保留同一标签页中结果不确定的提交身份，成功后清除；sessionStorage 不包含任务正文。无 header 的旧客户端保留原行为。
- `GET /api/config` 与 `PUT /api/config`：配置包含 `allocator`、`reviewer` 和 `executionDefaults: { global, projects }`。`global` 为可空的 `{ harnessId?, modelId?, reasoningEffort? }`；`projects` 为 `{ repoPath, execution }` 数组，`repoPath` 是规范绝对仓库路径，`execution` 支持相同的可选字段。每个任务字段按手动任务值 → 匹配项目默认值 → 全局默认值 → 分配器的顺序解析，未设置字段逐级继承。密钥不属于此配置，不会读取、显示或写入浏览器存储。

Harness 健康条显示 Codex、DSH 和 ZCode 的 `available` 状态；不可用时展示 API 返回的 `reason`。模型及思考强度选择不硬编码，来源完全是 capabilities 响应。
