# Super Plumber 与 Zero 的边界

核查日期：2026-09-24。参考 [Super Plumber 仓库](https://github.com/LUKAWI/super-plumber)、[README](https://github.com/LUKAWI/super-plumber/blob/main/README.md) 和 [MIT 许可证](https://github.com/LUKAWI/super-plumber/blob/main/LICENSE)。

## 决定

暂不把 Super Plumber 整体并入 Zero，也不替换 Zero 的核心队列。Zero v1 继续以 SQLite 保存任务、lease、Harness 尝试、额度等待、检查、审核和 DONE 证据。Super Plumber 适合以后作为**可选的任务规划图**：描述跨任务依赖、验收点和 agent 交接，Zero 执行其中被释放的节点。

## 能力映射

| 需求 | Super Plumber | Zero v1 | 判断 |
|---|---|---|---|
| 任务依赖、分解、交接 | YAML/Git 图，CLI、MCP、只读 Web UI，checkpoint 与 execution report | 当前以单任务为执行单元 | 值得引入可选规划层 |
| 双层 Harness + Model 路由 | 未核实到对 Codex、DSH、ZCode 的验证绑定与双层路由 | Codex 分配器和能力验证 | Zero 保持状态和决策权 |
| 五小时/周额度恢复 | 节点失败重试与 fallback；未核实供应商额度重置时间和同一执行 worktree 续跑 | 明确额度信号、持久 retry_at、阶段 checkpoint、同 worktree 续跑 | 无法用其替换 Zero 的额度机制 |
| 状态源 | `.graph` YAML、事件与索引 | SQLite + 任务分支/产物 | 同步双份状态会引入竞态和分歧 |

两个项目都使用 TypeScript，但 Super Plumber 自带一套图存储、状态机、MCP 服务和 Web UI。直接合并会增加状态映射、生命周期同步和验收归属；它的图适合作上层规划，而 Zero 保持唯一执行状态源。

## 后续试验的接口

先做单向适配：从 Super Plumber 的 `ready` 节点生成 Zero 任务，记录 `graph_id/node_id → task_id` 映射；Zero 完成后把报告摘要和 artifact 路径回写图节点。图只决定依赖何时释放，Zero 仍决定执行与 DONE。正式依赖前需核对相同版本的 npm 包、源码 tag、Windows CI 和 MCP 权限边界；当前仓库 README 声称 1.0.0，而可检索的 [npm 包页](https://www.npmjs.com/package/@lukawi/super-plumber) 显示较旧的 0.1.0，发布信息存在时间差。
