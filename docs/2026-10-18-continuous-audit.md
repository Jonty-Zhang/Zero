# 持续审查记录（2026-10-18 起）

从已合并的 main `7b199d5` 开始，使用 `codex/continuous-audit-2026-10-18` 继续。每项修复先确认正常使用中的触发路径，再补回归并独立复审；完成一轮后继续查下一轮。以下仅记录已确认的问题，不代表已经找完。

| 已确认问题 | 影响与验证 |
| --- | --- |
| 早期额度错误遮住当前认证/账单失败；错误超过 16 条后新的额度信息又被丢掉 | 真实 Node 子进程复现错误等待与漏等待。新增独立的有界 `lastProviderError`，只用最新真实 provider 错误分类当前非零失败，保留原始历史供诊断；模型冲突、不可验证协议和强制进程失败仍优先。最新失败诊断进入机器错误，便于用户处理账户问题。3 项回归先失败后通过，适配器与 quota 共 126 项通过；独立复审未发现阻止合入的问题 |
| 暂时不可用的已保存模型在设置 GET 中变成 null，原样保存后永久丢失 | GET 保留已保存选择；PUT 仅允许原样保留同角色的完整 model/effort 二元组，新选择仍需验证。网页显示“当前不可用”并保留该值。真实 HTTP 与组件测试先失败后通过，服务端 32/32、前端 19/19、类型检查和生产构建通过，Edge 375px 实际 HTTP 保存无溢出/页面异常；root 又独立重跑设置 HTTP 与浏览器回归，独立复审未发现阻止合入的问题 |
| 最终目标返工继承全部历史阶段检查 | 创建 first.txt、随后迁移成 second.txt 的正常计划会收到“first.txt 存在”和“不存在”两条矛盾命令，最终返工耗尽预算失败。返工现在只继承最后完成步骤的检查，历史检查保留在原任务及目标审查资料；没有移除最终约束。3 项真实 Git E2E 覆盖原流程、重命名后仅补 proof 即完成、破坏最终文件约束仍失败。sequence/revision/E2E 共 17/17 通过；独立 reviewer 重跑 goal 单元及 E2E 8/8 通过 |
| 普通返工成功的步骤仍被历史失败检查阻止总目标验收 | 真实 Git/SQLite/TaskWorker 复现 checkRuns=[failed, completed] 且 task 已 DONE，目标 reviewer 却从未被调用。现在沿 applied commit → sealed package → checkRun 选取权威证据，并校验报告、执行身份、快照、检查定义、完成事件及完整通过结果。真实回归覆盖成功返工、缺 package、错误 run、缺结果共 5/5；独立 reviewer 重跑新测试及 main 测试 20/20 通过，未发现阻止合入的问题 |

## 后续一轮

执行预设也有离线保存阻塞：即使 global/project 没变，修改无关设置仍因 CLI 暂时不可用被拒绝。现已保留原样设置；输入结构、仓库路径、新选择仍严格校验，global 变化影响项目继承时重新校验有效组合。真实 HTTP 回归先失败后通过；server 34/34、Edge 375px 实际保存通过，root 复验相关 HTTP，独立 reviewer 又跑 4 项边界通过。

首批五项修复已在 PR #2 合并到 main `ce9100350cb26813fb246e1e4e583bf9d3646681`。固定提交 `070cd03` 的本地全量 420/420；准确提交的 push/PR CI 均通过，Windows 420/420、Linux 418 通过及 2 项 Windows 专用跳过，前端 19/19、HTTP 客户端 10/10，发布与安装检查通过。

## 显式重新验收

另确认目标 reviewer 一次临时断线生成的 blocked 会跨重启永久缓存，界面没有重新验收入口。已增加绑定原 attempt ID 的持久请求、事务内消费与最新判定比较，并提供网页“重新验收”。旧判定和预算保留，额度等待、正在运行及 changes_requested 不能绕过；同证据的 blocked 仍需要明确点击，证据变化沿用原有重新验证规则。

核心存储 16 项、真实 HTTP 5 项、真实 Git/SQLite/TaskWorker E2E 6 项通过。E2E 覆盖重启恢复、并发点击、验收前后工作区变化、配置读取失败、额度与返工上限、旧调度器跨连接竞争。前端 30/30、客户端 11/11、类型与生产构建通过。Edge 1440/375px 的实际 HTTP/SQLite 联调确认队列跨刷新持久、单次请求事件、保留旧 findings 且无横向溢出。独立 reviewer 复跑各边界，未发现阻止合入的问题；本批全量及准确提交 CI 另行记录，定向结果不代替全量。

PR #3 已合并到 main `51623d81fbb9a8dcfd148a6da11ebd071b6e3594`，树与固定验证提交 `9cf378a` 一致。本地 447/447；准确提交的 push/PR CI 四项均成功，Windows 447/447、Linux 445 通过及 2 项 Windows 专用跳过，前端 30/30、客户端 11/11、原生/发布/安装检查通过。

## 接力续跑及网页焦点

提交任务时禁用全部控件会让 Edge 焦点退到 BODY，Tab 可进入背景并打开第二个模态。已用 document 键盘/焦点守卫和 busy 焦点回退修复；新增 2 项组件回归先失败后通过，前端共 32/32、类型检查和构建通过。独立 reviewer 与 root 都在 Edge 1440/375px 验证任务/序列提交、失败后恢复、Escape 门禁、焦点返回入口、详情折叠和抽屉替换。

审核要求返工时，后一个 agent 额度暂停后曾从阶段 0 重跑，恢复已删除的 plan.json 并导致最终检查失败。现将 quota checkpoint 与相同 continuation/revision/generation/owner 的不可变 progress 交叉验证，恢复准确逻辑阶段及暂停 writer 的衔接；仍获取 fresh route，不增加 revision。可证明的旧 writer 记录可推导位置，歧义旧多阶段 route 继续等待。新真实 Git 回归 5/5，原存储及 quota 兼容回归共 82 项通过；root 独立重跑新 5/5，reviewer 再验证跨三代 guardian 的 writer quota → route quota 链路通过。Git、claim 和最终验收门禁保留。

后续已确认配置读改写并发丢失：网页设置保存与 CLI 注册模型均成功，但后写入者擦掉对方更新。隔离真实 CLI + HTTP 已复现，继续修复完整读改写的互斥。

## DSH 当前诊断

DSH 将原样推理写到 stderr，旧提取器会把其中引用的 quota 与 Retry-After 当成当前错误，又丢掉最后的认证诊断。现在仅对 DSH text 使用最后一条 CLI 诊断及其续行，保留错误 code，避免旧推理影响当前认证、账单或重试时间；对外错误保留脱敏和 4096 字符上限。机器记录的 stderr 截断单独判断，真正截断时不据前缀授权额度恢复；stdout 单独截断、模型打印的截断标记不误伤正常额度诊断。

已从[官方 registry](https://registry.npmjs.org/@deepseek-ai/dsh-headless/0.1.5-rc.2)读取支持版本的[源码包](https://registry.npmjs.org/@deepseek-ai/dsh-headless/-/dsh-headless-0.1.5-rc.2.tgz)，sha512 与发布 integrity 一致，确认 `package/lib/index.js` 先写 `dsh: reasoning:`，终态为 `dsh: <code>: <message>` 或 driver 的 `dsh: <message>`。没有安装/执行包或调用模型；包元数据没有 gitHead，不声称对应某个 Git commit。完整适配器 134/134；root 独立重跑 DSH/截断相关 20/20。未带 framing 的旧 fallback 仍保留原有局限，Codex/ZCode 的终态顺序本轮不改；本机 DSH 入口未定位，不能据此宣称 live 验证。

PR #4 已合并到 main `9847f69b7b591e29a0922b80579c4aaf0904e8c5`，树与固定验证提交 `153d1b9` 一致。本地全量 463/463；准确提交的 push/PR CI 四项均成功，Windows 463/463、Linux 461 通过及 2 项 Windows 专用跳过，前端 32/32、客户端 11/11、原生/发布/安装检查通过。

## 配置并发及验证证据

设置、注册和绑定验证曾各自读取旧 JSON 后整份替换。现以规范路径共享的进程内异步队列及独立 SQLite 写锁，保护所有八个 mutator 的完整读取、动态校验、修改和替换；JSON 仍是配置权威。只对 SQLite busy 做有界异步等待，异常、持锁进程退出及写入失败均释放锁；不会取消仍活跃的持锁者。网页保存只合并用户设置，保留最新模型、绑定、验证及私有 metadata。

独立复审又复现实际 `runBindingVerification` 的另一处丢失：两个相同 CLI 版本的思考强度验证均成功，旧快照仍使其中一个 proof 消失。调用方现在只提交本次 proof，并在锁内按相同 provider/model tuple 及相同 binding/verification CLI 版本累积；相同 effort 的新证据覆盖旧证据，跨版本重新建立证据集合，模型 tuple 变化则拒绝旧验证结果且不改 JSON。

新并发测试 24 项及原配置 6 项由 root 独立重跑 30/30；实现者及独立 reviewer 分别跑配置、并发、main、server 共 79/79、0 跳过。覆盖真实 CLI + HTTP、两个 CLI 进程、Windows 大小写/8.3/junction、结束持锁进程、10 秒等待超时、rename 失败和旧配置。模型调用均为离线替身，未消费真实额度。整项目及准确提交 CI 单独记录；明确全量 settings 替换仍以后写者为准，外部不通过 ConfigStore 的编辑不参与此互斥协议。

所有新复现使用隔离 Git 工作区、SQLite 和本地 fake adapters，没有消耗真实模型额度或改写生产配置。执行进度见[持续审查计划](superpowers/plans/2026-10-18-continuous-audit.md)。
