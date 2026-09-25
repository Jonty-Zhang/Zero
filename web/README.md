# Zero Web UI

独立 React + TypeScript + Vite 前端。开发模式通过 Vite 将 `/api` 代理到 `http://127.0.0.1:4179`；生产环境由 Zero 服务托管静态构建目录。

```sh
npm install
npm run dev
npm run build
```

## API 契约

前端使用 JSON API。任务列表可直接返回数组，也兼容 `{ "tasks": [] }`。

- `GET /api/capabilities`：返回 `{ harnesses, bindings, allocator, reviewer }`。`harnesses` 项为 `{ id, name, available, reason? }`；`bindings` 项为 `{ harnessId, modelId, modelName?, available, reason?, reasoningEfforts: [{ id, label }] }`。`allocator` 和 `reviewer` 分别包含 `models` 与 `reasoningEfforts` 选项数组。UI 只允许手动选择 `available: true` 且其 Harness 同样可用的组合；思考强度只来自所选已验证 binding。
- `GET /api/tasks`：任务数组或 `{ tasks }`。
- `GET /api/tasks/:id`：任务详情，建议包含 `id`, `status`, `prompt`, `acceptanceCriteria`, `repoPath`, `baseRef`, `createdAt`, `route`, `attempts`, `tests`, `review`, `logs`, `report`, `error`。
- `POST /api/tasks`：接收 `{ repoPath, baseRef, prompt, acceptanceCriteria, maxRevisions, checkCommands, execution: { harnessId, modelId, reasoningEffort }, executionStages: [{ harnessId, modelId, reasoningEffort }] }`。手动项可为 `null`；`executionStages` 可省略，若提供则需包含 1 到 16 个阶段。`execution` 是任务级默认值，阶段字段会覆盖默认值；服务端会验证每个最终组合均对应当前可用且已验证的绑定，并保留阶段顺序。
- `POST /api/tasks/:id/cancel`：取消 pending 或活跃任务。
- `GET /api/config` 与 `PUT /api/config`：配置 `{ allocator: { modelId, reasoningEffort }, reviewer: { modelId, reasoningEffort } }`。字段可为 `null` 以交给 Codex 自动选择。密钥不属于此配置，不会读取、显示或写入浏览器存储。

Harness 健康条显示 Codex、DSH 和 ZCode 的 `available` 状态；不可用时展示 API 返回的 `reason`。模型及思考强度选择不硬编码，来源完全是 capabilities 响应。
