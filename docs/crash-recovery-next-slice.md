# 普通崩溃自动续跑：下一切片

状态：迭代 A 已实现；迭代 B 仍是设计，2026-09-26。本文区分已实现边界与后续方案。不代表 guardian 已在目标电脑安装或经真实重启验收。额度等待仍走独立 quota checkpoint 路径。

## 决策摘要

迭代 A 已开放一个窄恢复路径：仅接续**已创建并持久登记的原 worktree**，不重放旧进程结果。必须证明紧邻前代 guardian 已确认旧 Job 清空，并复核 worktree 身份、Git 注册、允许路径和新鲜 fingerprint。Zero 保留旧 attempt 历史、建立恢复检查点，之后从新的 route / execution 开始，重跑所有配置检查和 Codex review。任何身份/路径不匹配、review/commit/report 边界或缺少 lineage 的任务继续停在 `recovery_required`。本版本没有可幂等收尾的持久 commit intent；这属于迭代 B。

这只保证“旧 writer 不再并发、同一任务在同一 worktree 上重新执行全部门禁”，不保证旧模型动作可撤销、外部副作用可去重，也不恢复旧 session。第一版限定为**没有开始过审核/提交、`executionStages` 至多一个阶段、revision 为 0**的任务；多阶段接力、revision 中断和已有 review/commit 状态先隔离。

## Guardian 证据边界

当前 guardian 在持有用户 SID + 数据目录 lock ID 的 mutex 后，打开上一代命名 Job 并等待 `ActiveProcesses == 0`（Job 不存在时也继续），再生成 startup generation 并创建本代 Job。Node 把 `ZERO_GUARDIAN_*` 环境值按 lock ID 与数据目录核对后写入 `startup_generations`；任务 claim 和 stage 记录代际。这些字段适合做故障归因和 lineage 关联。

环境变量可以由同一 Windows 账户伪造，因此历史 `evidence_kind='guardian_env_assertion'` 和 `predecessor_drained=true` **不能单独视为恢复凭据**。当前 guardian 在旧 Job 清空后保留本会话的命名映射，记录代际及 guardian/直属子进程的 PID 和创建时间；Node 通过随包 helper 的 `--verify-startup` 核对这些值及新 Job 成员身份。只有成功的启动核验写入 `guardian_startup_verified`。这不是抵御同账户恶意篡改的安全边界：同账户本来就能运行/修改本地程序和 SQLite；本功能针对崩溃后的误接管与并发 writer。

在 `BEGIN IMMEDIATE` 事务内读取紧邻上一条 generation；仅当本代与上一代均为 `guardian_startup_verified`，本代 `predecessor_drained=1` 且 `lock_id` 一致时，才写入 `predecessor_generation_id`。空库、旧 `guardian_env_assertion` 行（即使 `member_verified=1`）、非 guardian 启动或 lock 不匹配都保持 NULL。`currentStartupProvesGenerationDrained(id)` 只根据本代证明、精确 predecessor ID 和被指向记录的证据类型与 lock 一致性返回真假；sequence、lease 和环境值本身不能替代 predecessor ID。该 lineage 现用于迭代 A 的恢复授权。

该关联不是防同账户篡改的认证机制。能写入 Zero 数据目录的同一账户也能编辑 SQLite 行并改变查询结果；它针对崩溃误接管和并发 writer，不针对本机同账户恶意行为。

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
| `created` 后、route 前 | repo/common dir/path/branch/base、创建时观察值和 fingerprint | 迭代 A 已实现：满足下述窄范围时复核 Git 注册与身份，重测 fingerprint 并从新 route 起跑 | identity/path、allowedPaths、HEAD 或 lineage 不匹配时隔离；Git 忽略的 build/cache 文件不纳入 fingerprint，可能残留并影响命令 |
| route 中或 route 返回后 | route attempt；route row 仅按 task 保存，无 attempt FK；保存 route 与 finish attempt 是两个事务 | 迭代 A 会在新 route 之后重做 execution、全部 checks 和 review，不沿用旧 route 作为权威 | route/check/review 旧记录只作为历史背景；尚无 phase intent 的逐阶段原子审计 |
| execution 前/中/返回后 | stage 有 UUID `processStartId`、generation、input fingerprint；attempt 有状态；显式完成后才有 output fingerprint/handoff | 迭代 A 已实现：旧 Job 清空、身份复核并新 claim 后，在同一 worktree 创建新的 execution attempt；旧树和输出按不可信上下文处理 | UUID 不是 OS 身份；不复用旧 session 或旧模型输出作为完成证据；仍不保证外部副作用可撤销/去重 |
| checks 准备/执行/结果写入 | checks 在运行前会 `git add -A` 并取得 tree/fingerprint/diff hash，但该快照仅在内存；check rows 分条写入 | 迭代 A 不恢复部分 checks：从新的 execution 后重跑全部配置检查和 review | 不能只从部分旧 check rows 推断通过，也不能直接恢复到 review；忽略的 build/cache residue 可能影响检查但不进入 Git fingerprint/diff |
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

### 迭代 A：已实现，限于执行前/执行中的单阶段任务

实现要点：

1. 使用 additive SQLite `execution_recovery_checkpoints` 保存恢复检查点；旧 attempt/stage/event 历史保留。检查点状态记录 claim、quarantine、inspection required、quota/终态禁用，以及再次崩溃后的 supersede lineage。
2. 候选必须有当前协议 lease-expiry 证据、前态 `running`、revision 0、最多一个 execution stage、完整且 HEAD 仍为 base commit 的已创建 worktree 记录，并由当前 guardian 证明任务 claim 所属的紧邻前代已清空。已有 review、commit/report 证据、额度 pause、多阶段或旧 protocol 均不符合候选条件。
3. Worker 重新打开已登记 worktree，核对 repo/common-dir/path/branch/base/HEAD、Git worktree 注册、changed paths 与 `allowedPaths`，并测量 fresh fingerprint。SQLite 事务原子写入恢复检查点和新 lease；启动模型前再次核对 fingerprint 和身份。只有通过后才从新 route、新 execution attempt 开始；旧 route/check/output/review 不会充当通过证据，所有配置检查和 review 会重跑。
4. 本地 commit（含 HEAD 不再是预期 base）、身份/path/allowedPaths 不匹配、lineage 缺失、inspection evidence 不足或恢复后身份再次变化都会留在 `recovery_required`。正常 quota pause 使用原有独立 checkpoint，不会变成 crash replay；终态会禁用 crash recovery checkpoint。
5. 没有逐阶段 phase-intent 表，也不逐一恢复 route、check、review、commit 或 report。整个 route/execution/check 不确定窗口按一个安全边界处理；review 和 commit/report 窗口继续隔离。恢复使用原 task/worktree，不恢复 Harness session，不保证外部副作用可撤销或去重。

自动化测试覆盖迭代 A 的主要恢复 gate、worktree 身份变化、重试 lineage、重新 route/execution/check/review 和隔离边界。该改动的 CI 结果需在提交后确认。目标电脑上的 guardian/计划任务重启及真实 Harness 故障注入仍未完成，不能据此宣称实机无人值守验收。迭代 B 的 review/commit/report 故障注入尚待实现。

### 迭代 B：待实现 snapshot-bound review 和 commit/report 收尾

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
