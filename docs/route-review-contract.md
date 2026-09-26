# 主分配与审核契约

本文件是 Zero v1 的实现约束。配置的主分配器负责路由选择，独立 Reviewer 固定使用 Codex；Zero 负责能力校验、状态、测试及 DONE 判定。

**当前决策（2026-09-26）：**在路由设置中可选择 Codex 订阅或 API 主分配器。API 主分配器通过兼容 OpenAI Chat Completions 的 HTTPS endpoint 工作，只收到路由提示并从已验证候选中选择执行绑定；它不执行或修改任务。API 配置中的 `baseUrl`、`model` 和 `keyEnv` 分别是 HTTPS 服务地址、分配模型 ID、Zero 服务进程环境变量的名称。API 密钥值不写入 Zero 配置；Codex Reviewer 仍固定使用独立只读会话。

## 分配输入

每个候选是经过 Adapter probe 的可执行绑定：

```json
{
  "bindingId": "codex:gpt_primary",
  "harness": "codex",
  "model": "gpt_primary",
  "reasoningEfforts": ["low", "medium", "high"],
  "capabilities": ["code", "review", "json_events"],
  "healthy": true
}
```

提交任务可指定 `selection.harness`、`selection.model`、`selection.reasoningEffort` 的任意子集。合并顺序：任务 > 项目预设 > 全局预设 > 当前主分配器（Codex 或 API）。Zero 先过滤健康度和兼容性，再将任务 brief、验收条件、仓库摘要、已锁定字段与余下候选组装为路由提示，交给当前主分配器。Codex 模式使用独立 Codex 分配会话；API 模式只向配置的 HTTPS endpoint 发送路由提示。

分配器不能在启动前为自己选择模型。Codex 模式使用已验证的 Codex CLI 分配模型；API 模式使用路由设置中的 API 模型，并从 Zero 服务进程环境按 `keyEnv` 名称读取密钥。若分配器模型、HTTPS endpoint 或密钥环境变量不可用，路由失败并保留诊断，不会回退到执行模型或未验证的默认模型。

## 分配输出

所选主分配器只输出一个符合路由 schema 的 JSON 对象：

```json
{
  "taskType": "debug",
  "complexity": "medium",
  "bindingId": "codex:gpt_primary",
  "reasoningEffort": "high",
  "reason": "失败堆栈明确，仓库有可运行测试，所选绑定符合任务需求。"
}
```

Zero 检查 JSON 结构、候选 ID、已锁定字段、effort 是否受该 binding 支持，再将每个字段的来源（task/project/global/codex/api）与候选快照写入 route 决策记录。主分配器的非 JSON 响应或不存在的绑定不可转为默认模型。如果全部字段已手动锁定，Zero 仍调用已配置主分配器完成路由分析，但不能改变执行组合。

## 审核输入与输出

审核一定是新的 Codex 会话，不复用分配或执行上下文。输入包括原始任务、验收条件、base commit、完整 diff（含新增文件）、机器检查结果和执行摘要。Zero 先固定暂存 Git tree，再运行全部检查；检查后和审核前均重新核对 tree、diff 哈希及工作树指纹。检查命令造成非忽略工作树变化时，记录完整性检查失败并进入有限返工，不能把旧检查结果用于新 tree。额度等待的审核检查点也保存该快照身份；缺少身份的旧检查点必须重新运行检查。Reviewer 的 sandbox 为只读；Zero 在审核前后比较 Git 状态，若发生任何写入则审核无效并记录故障。

```json
{
  "verdict": "changes_requested",
  "summary": "新增测试未覆盖空输入。",
  "findings": [
    {
      "file": "src/parser.ts",
      "line": 42,
      "severity": "high",
      "evidence": "空字符串进入该分支后抛出未处理异常。",
      "requestedChange": "处理空输入并增加回归测试。"
    }
  ]
}
```

合法 verdict 仅为 `pass`、`changes_requested`、`blocked`。审核输出必须通过 schema 校验；审核进程失败、结果缺失或非法时，Zero 记录审核故障，不能 DONE。`changes_requested` 生成返工 brief，加入检查失败证据，再交回执行 Harness。每次返工后重新测试和审核。

## Reviewer 独立性与 DONE

Reviewer 的 Harness 固定 `codex`。模型与思考强度可在 Zero 中手动配置；未配置时从已验证的 Codex 候选中选择，优先不同于执行模型。即使执行 Harness 也是 Codex 且模型相同，审核仍使用全新会话和只读权限，并在报告中标记此独立性限制。DONE 还必须满足检查通过、改动范围通过、结果提交到任务分支、报告归档。

## 必测反例

- 用户只锁定 `harness=zcode`，主分配器返回 `codex:gpt_primary`：拒绝。
- 用户只锁定 `model=glm_primary`，主分配器返回不兼容 Harness：拒绝。
- 用户锁定 `high`，该 binding 仅支持 `low|medium`：任务提交/路由即报配置错误。
- 主分配器输出不存在的 `bindingId`、不支持的 effort、格式错误或空理由：拒绝。
- 测试失败但 Codex reviewer 输出 `pass`：仍进入返工或失败，不能 DONE。
- 检查命令报告通过但修改了待审 tree：完整性检查失败；不能依据旧检查结果进入审核或 DONE。
- Reviewer 输出 `pass` 但进程非零退出：不能 DONE。
