# 普通崩溃自动续跑：下一切片

状态：实现设计，2026-09-25。范围是确认旧 writer 已退出之后，Zero 如何安全地继续原任务；不代表 guardian 已在目标电脑安装或经真实重启验收。额度等待仍走现有 quota checkpoint，不纳入本切片。

## 决策摘要

下一切片只自动接续**已创建并持久登记的原 worktree**，不尝试重放旧进程的结果。旧 Job 清空且 worktree 身份复核通过后，Zero 对当前文件状态重新取指纹，保留旧 attempt 历史，建立新的 recovery attempt；从新 route / execution 开始，重新跑全部检查和审核。只有数据库中已持久化、且能和 Git 当前状态逐项核对的提交意图可以被幂等收尾。无法确定阶段或证据不匹配时继续停在 `recovery_required`。

这只保证“旧 writer 不再并发、同一任务在同一 worktree 上重新执行全部门禁”，不保证旧模型动作可撤销、外部副作用可去重，也不恢复旧 session。第一版限定为**没有开始过审核/提交、`executionStages` 至多一个阶段、revision 为 0**的任务；多阶段接力、revision 中断和已有 review/commit 状态先隔离。

## Guardian 证据边界

当前 guardian 在持有用户 SID + 数据目录 lock ID 的 mutex 后，打开上一代命名 Job 并等待 `ActiveProcesses == 0`（Job 不存在时也继续），再生成 startup generation 并创建本代 Job。Node 把 `ZERO_GUARDIAN_*` 环境值按 lock ID 与数据目录核对后写入 `startup_generations`；任务 claim 和 stage 记录代际。这些字段适合做故障归因和 lineage 关联。

环境变量可以由同一 Windows 账户伪造，因此 `evidence_kind='guardian_env_assertion'` 和 `predecessor_drained=true` **不能单独视为认证凭据**。实现恢复前必须确认受支持的启动路径确实由 guardian 承载，并且 Node 获得的 predecessor-drained 结论来自该受监督启动流程，而不是仅接受可复制的 env。可用 guardian 到子进程的继承句柄/本地 IPC 握手绑定启动代际；若无法在运行时建立可信的 guardian 启动关联，则自动续跑 gate 关闭，任务保留 `recovery_required`。这不是抵御同账户恶意篡改的安全边界：同账户本来就能运行/修改本地程序和 SQLite；本功能针对崩溃后的误接管与并发 writer。

只有满足以下全部条件，已有 worktree 才进入恢复候选：

1. 本代由受支持 guardian 启动；数据目录 lock ID 匹配；guardian 已在获得 mutex 后确认 predecessor Job 清空。无法取得该证据时不自动恢复。
2. 该任务的 lease generation 与被清空的 predecessor generation 对应，或任务记录可明确证明 writer 属于刚被清空的旧 Job。generation 缺失、协议版本旧、或 lineage 不连续都隔离。
3. SQLite 中有完整 `worktree_creations.status='created'` 记录。复核 canonical repo、Git common dir、任务 worktree 路径、分支和 base commit；`git worktree` 注册关系有效，HEAD 可从 base commit 到达。
4. 在确认旧 Job 清空之后重新计算当前 worktree fingerprint。将它作为新的、不受信任的恢复输入基线；不能把旧 stdout、未终结的 attempt、旧 route、旧 checks 或旧 review 当作完成证据。
5. claim 与恢复授权在 SQLite 事务中完成，且一次仍只有一个活动 writer lease。仅 lease 过期、PID 不存在、report 文件存在或 env 字段看似有效均不够。

## 当前证据可支持的重入范围

| 崩溃位置 | 当前持久证据 | 清空旧 Job 后可做什么 | 仍缺的证据 / 禁止行为 |
|---|---|---|---|
| claim 后、worktree 创建意图前 | claim generation、协议版本；没有 creation/attempt/stage/route/check/review 行 | 现有实现可在新鲜确认 worktree 路径不存在后重新排队；这是写入前重入 | 不得将 generation env 本身当作身份认证。升级前协议或存在任一写证据时不得走此捷径 |
| creation intent 后、created 记录前 | `worktree_creations` 的 plan；外部 `git worktree add` 可能已部分或完整生效 | 不自动继续或删除；隔离，要求检查 Git 注册与路径 | intent 没有完成观察值/fingerprint，不能判断命令是否完成 |
| `created` 后、route 前 | repo/common dir/path/branch/base、创建时观察值和 fingerprint | 若上述身份复核通过、当前树可重测，可以新建 route attempt | 当前实现对所有已有 worktree 拒绝自动复用；没有 recovery baseline/intent |
| route 中或 route 返回后 | route attempt；route row 仅按 task 保存，无 attempt FK；保存 route 与 finish attempt 是两个事务 | route 可重跑，且不沿用含糊的最后 route；创建新 attempt | 旧 route 不能可靠归属到成功 attempt，也不能与输入树、配置/绑定版本成对核验 |
| execution 前/中/返回后 | stage 有 UUID `processStartId`、generation、input fingerprint；attempt 有状态；显式完成后才有 output fingerprint/handoff | 旧 Job 清空并重测 worktree 后，允许在同一 worktree 开一个新的 execution stage/attempt；把现存树视为不可信上下文，之后全跑 checks/review | UUID 不是 OS 身份；中断 stage 没 output fingerprint。不能把未终结 attempt 或模型叙述算作已完成，也不能复用旧 session |
| checks 准备/执行/结果写入 | checks 在运行前会 `git add -A` 并取得 tree/fingerprint/diff hash，但该快照仅在内存；check rows 分条写入 | 第一切片将 checks 视为不确定，重启新的 execution 后重新跑全部 checks | 当前没有持久 check intent、snapshot ID、定义/config hash、整组完成 marker；不能只从部分旧 check rows 推断通过，也不能直接恢复到 review |
| review 准备/调用/结果保存 | review snapshot 仅在内存；review result 保存时只关联 attempt ID，snapshot 未落 SQLite | 第一切片不自动接续已进入 `reviewing` 的 task；隔离 | 旧 verdict 没有与 tree/diff/check evidence 的 durable binding。即使 result row 存在也必须丢弃并重新审核 |
| commit 前/中/后 | `commit()` 以本进程内的 reviewed snapshot 验证；SQLite 没有 commit intent、pre-HEAD、reviewed tree 或 result commit | 当前均隔离。第二迭代可在补齐持久意图后按精确 Git 证据幂等收尾 | 不能从 HEAD 有新 commit、review pass 或报告文件推断可以 DONE |
| report 临时文件/rename/DONE 之间 | report 先写临时文件再 rename，随后 worker 再验 commit，最后 SQLite transition 到 done；读报告以 SQLite status 覆盖 | SQLite `done` 才是完成权威；未 done 的 task 不得因 report 出现而补 DONE | 无持久 report intent/hash；崩溃后不能证明报告对应当前 DB/Git evidence |

## 各阶段的持久意图与重新验证

### Route

在调用 router 前事务插入 `phase_intents`：`task_id`、阶段序号/恢复代数、`phase='route'`、新 attempt ID、claim generation、revision/stage index、worktree identity、输入 fingerprint、task/config/check-definition hash、期望 allocator/binding 版本、`status='started'`。route 完成时将 route decision 与该 intent/attempt 原子绑定并标成功。

route 是可重复的协调模型调用，但重复可能消耗额度。崩溃在开始、调用中、返回但未持久化时一律新建 attempt 重新 route；不复用未明确成功绑定的 route row。route 成功后 crash、execution 尚未开始时，可复用的只能是事务中已绑定且 selection/config 仍匹配的 route；为了让首片实现更小，也可统一重新 route。

### Execution

在子进程启动前持久化 stage/attempt intent：新的 attempt ID、generation、route decision ID/hash、task ID/revision/stage index、worktree identity、输入 fingerprint、Harness/model/version、binding/config hash、prompt/handoff hash。启动后追加 supervisor/job 身份和 OS PID+creation time（PID 单独不够）；最终记录 exit/终态及 Zero 重新测得的 output fingerprint。普通崩溃无成功终态时，旧 attempt 必须留作 `interrupted`，不得把 artifact/log/session 文件当作结果。

在本切片中，Job 清空后可以将当前 fingerprint 作为新的起点，以新 attempt 继续同一 worktree；旧模型输出只作不可信背景，交接只陈述 Zero 测到的文件/Git 事实。旧 route、checks 和 review 都不作为门禁证据；完整 checks/review 必须在新 attempt 后重做。先限制单 execution stage 且 revision 0，避免误把一个多阶段流水线错误定位到中间边界。

### Checks

在检查开始前持久化 `check_intent`：worktree identity、review snapshot 的 `treeId/fingerprint/diffHash`、完整 check-definition/config hash、预计 check ID 集合、execution attempt ID。把所有结果写入同一 `check_runs` 记录或以事务性的 run ID 聚合；每项结果绑定该 run ID。全体成功后再写完成 marker。检查后复测 snapshot，必须与开始前一致，否则整组失效。

第一切片不尝试恢复中断的 checks：execution 和 checks 阶段难以从现有状态区分，且测试命令可能有副作用。它们统一从新 execution 后重跑。后续只有完整意图、配置 hash、snapshot、旧 Job 清空和 checks 可重复策略都满足时，才可在同一冻结 tree 上重跑 checks；不得沿用部分结果。

### Review

审核前持久化不可变审核包：tree ID、fingerprint、diff hash、base commit、HEAD、通过的 check run ID/definition hash、route ID/hash、review attempt ID。review result 与这个包 ID、review attempt 原子关联。

任何普通崩溃都使旧 review verdict 失效，包括 reviewer 已返回但 SQLite 尚未保存、review row 已保存但 attempt 尚未成功、review 已成功但 commit 未开始。审核是只读模型调用，可在树和 check run 精确核验后创建新 attempt 重跑；不复用旧 verdict。第一切片对 `previousStatus='reviewing'` 仍隔离，因为当前没有持久 check snapshot / reviewed snapshot 可完成核验。

### Commit

commit intent 必须在 `git commit` 前事务写入并绑定已成功的 review package：pre-HEAD、base commit、reviewed tree ID、diff hash、worktree fingerprint、commit message/hash 和唯一 commit operation ID。恢复时仅允许两种精确结果：

- HEAD 仍是 pre-HEAD，当前 index/worktree 与审核包完全相等：可以重新执行相同 commit 操作。
- HEAD 是 pre-HEAD 的直接后继，且 commit tree 等于审核 tree、diff hash 相等、父提交等于 pre-HEAD、操作记录匹配：将该 commit 记为成功。

任一其它 HEAD/branch/tree 状态进 `recovery_required`。同一树内容不一定代表同一次受审操作；仍需审核包与 commit intent 的数据库绑定。

### Report / DONE

report intent 在 commit 成功后、文件写入前持久化：report schema、task status target、commit SHA、review package ID、输入 evidence/event 高水位、目标 artifact 路径及预期内容 hash。临时文件写完并 rename 后复读计算 hash；匹配才写 report-complete marker。最后一个 SQLite 事务确认 lease 仍属本 generation、commit proof 与 report marker 均完整，再写 `done`。任一缺失都不能基于 report 文件补 DONE。report 重建只能从同一组数据库证据确定性生成并匹配预期 hash；否则隔离。

## 两个小迭代

### 迭代 A：只恢复执行前/执行中的单阶段任务

实现者可直接按以下范围动手：

1. 增加协议版本化的 phase intent / recovery record 表（或等价 additive 列），至少覆盖 route、execution、checks、review、commit、report 的 `started/completed` 意图；不重写现有 attempt 历史。
2. 恢复 gate 要求 guardian 启动关联、前代 Job 清空证据、worktree creation 完成记录和 repo/common-dir/path/branch/base/HEAD 核验。env 只用于诊断关联，不得单独授权自动重入。缺任何一项都保留 `recovery_required`。
3. 自动恢复仅限 `running` 的 route/execution/check 歧义窗口、revision=0、单 execution stage、尚无 review/commit/report intent 的任务。验证 worktree 当前 fingerprint 后，从**新 route + 新 execution attempt**起跑。checks、review 全部重跑；旧 review 不适用；阶段输出、handoff/日志仅是非权威背景。原 task ID/worktree 不变，revision budget 不增加。
4. 对于 `reviewing` 和一切 commit/report 窗口保持隔离。若执行器无法确认受监督启动来源，整个迭代退化为隔离，不做普通崩溃自动重入。

故障注入：在 route intent 前、route call 后/route save 前后、execution intent/attempt/spawn 前后/写文件后、check prepare 前/中/部分结果后分别强制结束 guardian 或整个 Job；新 guardian 必须等 Job 空，再启动恢复。断言：没有第二旧 writer；task/worktree ID 不变；新 attempt ID 与旧不同；route/execution 按范围重做；checks/review 必须新执行；部分旧 check、所有旧 review 不能使任务 DONE；tree/repo/branch 不匹配、旧版本 DB、缺 guardian lineage、证据缺失时停在 `recovery_required`。还要测同账户设置伪造 `ZERO_GUARDIAN_*` 不能单独通过自动恢复 gate，以及 lease 先未过期、随后由运行时扫描隔离的情况。

### 迭代 B：加入 snapshot-bound review 和 commit/report 收尾

持久化并绑定 check run、review package、commit intent、report intent/hash。启用两类额外重入：

- 任务已进入 reviewing 且完整 check package 与 worktree 精确匹配：重跑 reviewer 新 attempt，不复用任何旧 verdict，然后继续。
- 有完整 commit intent：按上文精确比较 HEAD/tree 来幂等完成 commit/report/DONE；不能匹配就隔离。

故障注入：reviewer 返回前、返回后保存前、saveReview 后 attempt finish 前、review 成功后/commit intent 前后、Git commit 后、report 临时写/rename 后、report 完成 marker 后及 DONE 前逐点崩溃。断言旧 verdict 永不直接通过；仅精确 tree/check/review/parent commit 组合可完成提交；部分/伪造/陈旧报告不能写 DONE；提交或报告证据不一致时不重试写入并进入隔离。迁移测试覆盖旧 DB 中 NULL generation、没有 snapshot/intent 的历史任务一律不获得新自动恢复资格。

## 不变量与验收边界

- 先由 guardian/受监督启动路径证明前代 Job 清空，再复核 SQLite 与 Git，最后取得新 lease 并启动新 attempt。
- 一个 task 同时只有一个 writer；旧 attempts/stages 保留，任何续跑都有新 ID；worker 不得先把不确定任务放入普通 `pending`。
- route 可重算；execution 只能以当前 worktree 的新鲜指纹为输入；checks 必须整组、绑定精确 tree/config；review verdict 必须绑定准确审核包；普通崩溃后旧 verdict 一律作废。
- 只有 DB 中有可核验的 review + commit + report 证据，且最后一次 Git 核验通过，才能转换 `done`。artifact/report/HEAD 任一单独证据都不能替代。
- 此设计不验证计划任务、登录身份、网络、额度重置或目标机重启；这些仍需部署验收。环境变量 lineage 不提供同账户抗伪造保证。
