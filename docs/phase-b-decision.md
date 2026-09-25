# 审核、提交与报告的崩溃恢复：决策草案

状态：2026-09-26 设计决策；隔离 Windows Git 实验与独立审查已完成。本文只规定下一阶段的实现边界，不表示迭代 B 已完成或经过目标电脑验收。

## 目标与前提

迭代 A 已能在 guardian 证明紧邻前代 Job 清空后，对单阶段、revision 0、尚未审核的任务，在同一 worktree 重新路由、执行、检查和审核。迭代 B 要处理 `reviewing`、Git 提交和报告归档窗口。所有恢复仍先进入 `recovery_required`；只有证据逐项通过，才由专用事务取得新 lease。旧协议和缺少新意图记录的任务继续隔离。

任何旧审核结论都不单独作为恢复后的通过凭据。若审核 attempt、通过 verdict、不可变审核包和完整 check run 已原子绑定，且 guardian 证明旧 writer 清空、当前 Git 快照与审核包完全一致，即使 commit operation 尚未写入，也可复用该审核结论并新建提交意图；缺少通过证据时重新调用 Codex review。已有 commit operation 的任务还须按精确候选 SHA、分支和对象证据核验后续状态。报告文件、HEAD、退出码或租约到期各自都不能授权 DONE。

## 持久证据

1. `check_runs`：一个 run ID 绑定执行 attempt、工作树 `baseCommit` / `preHEAD` / `treeId` / `fingerprint` / `diffHash`、完整检查定义的哈希、预期检查 ID 集合、逐项结果，以及整组完成 marker。只有结果齐全、全部通过且检查后树未变时写 marker。检查完成而整组 marker 未写的崩溃，重新运行整组检查；不从零散的旧 `checks` 行拼凑通过证据。
2. `review_packages`：不可变 package ID 绑定完成的 check run、当时的 route 与执行 attempt、审核前 Git 身份和有界完整 diff。审核 attempt/result 必须引用 package ID；审核返回后重测同一树，再在一个事务中结束 attempt、保存 verdict。返工状态转换随后执行；若在这两步之间崩溃，须按 package、verdict、attempt 和 Git 现场判定，不能由旧 review 行自动推进任务。通过 verdict 的原子证据链可在严格复核后授权新建 commit operation；已落库的完整提交意图按其专门协议核验。
3. `commit_operations`：在任何 Git 分支写入前保存 operation ID、package ID、准确的 `refs/heads/zero/<taskId>`、`preHEAD`、已审核 tree/diff、提交信息，以及固定的作者/提交者身份、时间和编码。候选 commit SHA 单独持久保存；状态只能按明确的事务前进。状态列只是审计进度；Git 对象和分支引用才是提交是否发生的事实来源，SQLite 负责授权和绑定证据。
4. `report_operations`：绑定已核验的 commit SHA、package ID、事件高水位、固定目标路径、规范化报告 JSON 与 diff 的内容和 SHA-256。报告正文保存在本地 SQLite；应用文件从同一字节串生成，不能从后来变化的历史重新猜测。两份内容均设大小上限；`result.diff` 与 `report.json` 都先有持久意图，再从固定字节落盘。

以上表只追加新记录或推进明确状态，不修改旧 attempt、stage、review 或检查历史。所有改动使用 additive migration。每个能授权外部动作或 DONE 的事务同时核验任务状态、owner、未过期 lease、当前 claim generation 和关联 package/operation ID。

## 提交协议

审核通过且 package 仍与当前 Git 状态一致后，先持久化 commit operation。`git commit-tree <reviewedTree> -p <preHEAD>` 只创建对象，不移动分支；取得 candidate SHA 后核验它的 parent、tree 和 base-to-commit diff，再保存 candidate SHA。若对象创建后、SHA 保存前崩溃，可能留下不可达对象，但分支未变；可以安全地重新创建候选对象。作者、提交者和时间必须取自 intent；隔离实验确认若让 Git 使用当下时间，同样的 tree、parent 与 message 在两秒后可产生不同 SHA。

随后执行 `git update-ref <taskBranchRef> <candidate> <preHEAD>`。带旧值的条件更新只在分支仍指向 `preHEAD` 时移动引用。恢复时仅接受分支精确指向 `preHEAD` 或已持久化的 candidate；前者重新核验 package/工作树后重试条件更新，后者先用 `git cat-file -e` 确认对象存在，再核验 commit、分支、index 和干净工作树后记录完成。其他 HEAD/ref、tree、parent、diff 或 index 状态一律隔离。若 Harness 已在审核快照前自行提交，且审核时 `preHEAD` 的 tree 就是 reviewed tree，核验 base-to-HEAD diff 与干净状态后将 `preHEAD` 记作 candidate，不再移动分支。审核包创建后分支才移动，即使内容相同，v1 也隔离。

`update-ref` 遇到残留 `.lock` 不等同于 CAS 冲突。恢复代码不得仅凭租约到期自动删除锁文件；先证明前代 guardian Job 已清空，再明确判定锁的归属和状态。v1 无法证明时隔离，保留现场供人工检查。

此协议不运行 Git commit hooks，也不会继承常规 `git commit` 的签名流程。Zero 的配置检查和 Codex 审核是本流程的放行门禁；项目若依赖 hook，必须把相应命令显式列入任务检查。是否支持可选签名另行设计，不能在恢复中无声改变 candidate。

隔离 Windows worktree 实验确认：`commit-tree` 不会移动 HEAD；`update-ref` 的旧 SHA 不符时返回失败且不移动分支；CAS 成功后附着 worktree 的 HEAD 指向 candidate，若 index/文件原本与 reviewed tree 一致，工作区保持干净；用旧 SHA 再试一次仍会失败，因此恢复逻辑必须先比较当前 ref 与已保存的 candidate。Git 引用的 CAS 本身不会修复 index 或工作区。

## 报告与 DONE

commit 完成且再次核验后，以固定输入构造 report operation，先在 SQLite 保存报告 JSON、diff 字节和各自哈希。用排他方式创建同目录临时文件，写完后对文件执行 `sync()` 并关闭，再 rename 到目标名、复读并核对哈希；若文件缺失或不符，重启时只能从已保存的相同字节重写，不能依据现有文件推断完成。两个产物都核对后写 report-complete marker。SQLite 中的完整字节是归档权威，文件是可修复的投影；即使 DONE 后发现文件丢失，读取路径也必须能从数据库内容恢复。

最后一个专用 SQLite 事务重新核验 lease、generation、package 的通过结论、commit operation、report marker 和目标状态，才转为 `done`，同时清除 lease、额度暂停并禁用恢复检查点；不能复用宽泛的 `transition()`。`readReport` 可展示文件，但任务状态仍以 SQLite 为准。即使报告内容写着 DONE，只要事务未提交，任务仍是 `recovery_required` 或 `reviewing`。最终 Git 核验发生在该事务之前，外部进程在核验和事务之间移动引用仍是残余竞态；目标机器验收要注入这一时序。Zero 目前保留任务 worktree 和分支供审计，不引入 DONE 后自动删除。

## 恢复范围与实施顺序

1. 增加 check run / review package 的不可变绑定，并让 `running → reviewing` 与 package 创建在同一事务完成。`reviewing` 中断后先核验 guardian lineage、package、check run、review attempt/verdict 和新鲜 Git 快照；完整通过结论可复用，缺少 verdict 时重新调用 Codex review。检查定义或树变化时隔离，不复用部分结果。
2. 加入 commit operation 与 Git 候选/CAS API。先在一次性隔离 worktree 验证 Windows 上 ref、HEAD、index 和崩溃重入的实际行为，再接入 worker。
3. 加入 report operation 的内容哈希、双文件核验及最终 DONE 事务。旧数据库没有 package/operation 的行不会被自动升级为可恢复任务。
4. 故障注入覆盖审核调用前后、审核结果/attempt 事务、commit 对象创建前后、candidate SHA 落库前后、条件 ref 更新前后、报告意图与两个文件 rename 前后、marker 与 DONE 前后；还要覆盖外部移动分支、自提交、残留 Git lock、候选对象丢失、变更检查定义、改动忽略文件、并发 worker，以及 guardian lineage 缺失。旧库缺少 package/operation 的任务不得自动获得 B 恢复资格。

目标电脑上的真实开机、重复进程崩溃、订阅额度重置和 GLM/DeepSeek 接入需要单独验收。Git 忽略的缓存文件不在当前 fingerprint 内，可能影响命令；恢复后的检查应采用可重复构建策略，不能将缓存视为审核证据。

本协议首先覆盖进程崩溃。持久 SQLite 连接已显式核验 WAL + `synchronous=FULL`；候选 Git 对象和引用写入，以及审核树的 blob/tree 创建，已在相关命令上使用 fsync 设置。隔离 Windows 实验中，Node 文件 `sync()` 可用，但目录 `sync()` 返回 `EPERM`，普通 `rename()` 不能据此宣称断电后目录项必然保留；因此报告文件必须可由 SQLite 固定字节修复。断电和操作系统故障还需要在目标电脑上验证存储设备行为与实际重启流程，完成前不声称具备断电级的 exactly-once 保证。
