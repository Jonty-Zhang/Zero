# 第二轮：跨 agent 语义接力与执行可靠性

用户要求继续深入审查。本轮基于首轮 `9809ebb`，继续使用 `codex/agent-workspace-improvements` 与 [PR #1](https://github.com/Jonty-Zhang/Zero/pull/1)。所有复现使用隔离工作区、本地 Node 子进程或 HTTP fixture；没有执行付费模型任务或修改生产绑定。

## 已复现并改进

| 问题 | 原因与结果 | 修复和验证 |
| --- | --- | --- |
| 多 agent 只有换模型，没有分工 | 所有阶段收到同一总任务；`executionStages` 没有目标字段 | 增加可选 `objective`，trim 后 1–4000 字符；贯通网页编辑排序、API、CLI stages-file、数据库重开、路由及每位执行者。只把选择字段送入 selection，目标不改变整体独立审查范围 |
| 上一位 agent 的判断与未完成项丢失 | worker 忽略 `RunResult.final`，HandoffV1 只有固定机器模板 | 摘要保存到对应 attempt metadata、handoff 和报告；后继收到已验证来源/工作区的非可信 JSON 资料。最多 3000 UTF-16 字符、8 KiB UTF-8，不截断 Unicode code point；进入 prompt 时继续受总上下文预算限制 |
| 提交成功后才发现模型组合冲突 | API 只验证请求字段，router 还继承项目和全局默认值 | 提交前按同样的逐字段继承规则校验，包括各阶段与序列；只持久化原始手动选择，不伪造字段来源。真实 TaskRouter 复现 201 后拒绝，修复后提交阶段即明确拒绝 |
| 检查显示混入已失效历史 | `store.checks()` 平铺全历史，返工前失败和返工后通过同列展示 | 用 check-run、事件顺序、当前 writer、阶段及恢复边界选择当前批次，其他结果进入历史；缺少证据明确标记无法确认归属；独立工作树完整性失败仍显示失败 |
| HTTP 超时重试重复启动任务 | 客户端超时不能撤销已送达服务端的 POST | SQLite 原子保存 key/hash、资源和事件；任务与序列都支持 `X-Idempotency-Key`。并发或重启重放返回原 ID、不重复 enqueue；换内容/跨接口冲突 409。网页断线/超时/同标签页刷新后保留未确定提交的身份，成功后新提交使用新 key |
| 长输出丢失真正最终答复 | 进程只捕获 stdout 前 2 MiB，final 在后面被丢；reasoning/tool completed 还可能覆盖 agent final | 结构化输出逐行流式解析，独立于有界归档前缀；超过 256 KiB 的单行丢弃并恢复后续完整行。最终消息、初始 session/model 与错误独立保存；超大终态无法确认时明确失败，不能冒用旧思考。保留 secret redaction 与模型身份冲突拒绝 |
| 普通执行失败被误判为额度等待 | 整段 stdout/stderr 搜索 quota 字样，包含 agent/tool 引用 | 只接受结构化 provider 错误；无结构化输出时使用受限的 provider stderr 回退。保留非零失败退出要求，普通引用不会暂停成额度等待 |
| 返工检查再失败后丢失原审查要求 | 重建 revision brief 时传入 `review=undefined`；guardian 恢复同样遗漏 | 活跃 continuation 绑定原 package/verdict，后续检查重试与恢复都携带具体审查要求。六次写入、两轮审查、一次中间检查失败的真实 Git 回归验证；不扩大 revision 次数或完成门禁 |
| 不可证明的 Git 失败在网页只剩绿色命令 | HEAD/分支移动或未知 I/O 无法建立完整 integrity record，但该批次仍已失败 | 独立复审复现后，按准确 attempt 与事件边界补回已保存的失败 gate；完全缺少 gate 时显示 failed-run 原因。6 项真实 Git 流程通过 HTTP 复验；检查批次建立前的 I/O 失败只保留历史检查，不复用旧绿色结果 |
| 执行者自述遮住实际错误 | attempt.summary 优先采用模型 final，即使机器报告模型身份不符 | 机器错误优先，另以 executorSummary 显示有来源的非可信自述；API 与网页回归覆盖“自述完成但实际失败” |
| Windows 上默认 npm 检查根本无法启动 | TestRunner 用 shell:false 直接 spawn npm；Windows npm/npx 通常为 .cmd，实际复现 spawn npm ENOENT | 按 PATH 及准确命令文件找到已安装 npm/npx 的 JS 入口，直接由同目录 Node 或 PATH Node 执行；保持 argv 边界、原始检查定义和既有环境限制，不自动启用 shell。不存在的显式路径和未知脚本不冒充成功，启动同步异常保存为 spawn_error |

## 证据与记录

- `5c4150e`：第二轮设计与实施计划。
- `1ffe8e4`：阶段目标、语义摘要、编辑界面与有效默认组合校验。阶段/API/CLI 新增行为 8 项先失败后通过；store/server 共 109 项通过；前端组件与轮询 17 项通过。
- `c48d049`：持久幂等与检查归属。7 项真实 HTTP 回归覆盖并发、响应中断后重试、配置变化、任务序列与冲突；core 并发测试使用独立 SQLite 连接。客户端 10 项请求回归通过，包含同标签页重新加载；检查选择 4 项定向测试通过。
- `8438a6a`：流式最终输出、错误分类和模型冲突校验。适配器全套 110 项通过，覆盖超过 3 MiB 的工具输出、UTF-8/secret 跨 chunk、真正最终答复、错误引用额度字样、ZCode 官方 response 形态和 DSH 原有多行文本。
- `b607512`：审查要求跨检查重试及 guardian 恢复。3 项真实 Git 接力流程与包含多个边界的 guardian 恢复测试全部通过；任务详情 HTTP 断言同时验证当前与历史检查分区。
- 真 Edge 桌面 1440px 与移动 375px 验证：阶段目标编辑/重排/提交、执行自述纯文本、检查历史折叠、失去提交响应后使用同 key 重试、无横向溢出、无 pageerror。使用真实静态服务与 CSP，数据为隔离 fixture，不代表生产模型任务。
- `b607512` 的本机完整核心 **390/390** 通过（约 12 分钟）；[精确提交 CI](https://github.com/Jonty-Zhang/Zero/actions/runs/39028494727) 的 Linux 与 Windows 全部成功，包括 guardian、打包、安装/卸载 smoke。Linux 日志确认 core 390、frontend 17、API 10 无失败。
- 最后两项展示问题均经过 RED→GREEN：35 项服务端/证据测试、11 项真实 Git 与证据测试、前端全套 **18/18**、API **10/10**、类型检查及生产构建通过。独立复审确认无遗留 Important/Critical；最终新增回归使核心测试总数增加至 391。新增提交的精确 CI 结果以 [PR 检查](https://github.com/Jonty-Zhang/Zero/pull/1/checks) 为准，不把此前提交结果冒充后续提交结果。
- 后续默认流程审查真实复现 npm 启动阻塞，4 项新测试覆盖配套/PATH Node 选择、缺 Node、命令扩展名、坏 shim、空格与 shell 字符参数、未知 wrapper 失败，以及真实安装 npm 执行隔离项目的 `npm test`；连同原 TestRunner 回归 **5/5** 通过。真实 `npm --version`、`npx --version` 从失败变为通过；没有安装包或请求模型。独立审查提出的 Node 版本和不存在显式路径问题均以 RED→GREEN 修正并复审通过。
- 同一链路还复现 API 错拒 `npm test -- --runInBand`：移除对标准 `--` 字面分隔符的误拦截，保留命令分词与 shell 控制字符限制；新增真实 HTTP 用例证明 npm/node 参数原样持久。服务端、调用解析及执行器共 **36/36** 通过，独立审查通过。核心测试总数现为 396，两个实际 Windows 执行用例只在 Windows 运行。

## 保留的边界

HandoffV1 中机器事实与执行者自述分开；`decisions`/`rejectedOptions` 不会从任意模型 prose 自动提升为可信结构。上下文有界，不能保证完整保留长会话中每项细节。DSH 的非结构化长文本仍受诊断输出上限影响；本轮流式终态识别针对 Codex/ZCode 的结构化协议。

已修复的 stdout 截断、额度误判和返工要求丢失有确定性回归，不能据此认定历史 ZCode 偶发 app-server 错误也已解决。DSH 真调用、Start Plan、自然额度耗尽与恢复、多阶段任意崩溃边界仍需独立真实验收。服务端全文检索、历史分页及日志按需读取仍是后续性能工作。
