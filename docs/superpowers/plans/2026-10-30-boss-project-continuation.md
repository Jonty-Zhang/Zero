# Boss Project Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让用户从已验收的 Boss 成果继续派发下一步目标，避免误从原仓库 HEAD 重新开始。

**Architecture:** 前端把服务提供的成果提交固化到下一任务草稿并沿用现有 baseRef 参数。既有服务验证、提交幂等、Worker 独立工作区与验收协议保持原样，不新增后端权限。

**Tech Stack:** React/TypeScript、Vitest、Node test、Git、SQLite、现有 HTTP API。

**Spec:** `docs/2026-10-30-boss-project-continuation.md`

## Global Constraints

- 只修改本仓库；不用真实模型或个人配置；不触发自动合并/推送产品行为。
- 新入口只打开表单；新目标留空；仅 done Boss + 原项目路径 + 完整 SHA 可用。
- 使用原项目与成果 SHA；不复用旧 worktree 的 HEAD；切换文件夹不沿用不属于它的固定版本。
- 既有不确定提交身份必须涵盖 baseRef；连接表单和高级表单切换不丢失起点。

## Review Focus

- 原项目 HEAD 已推进时仍从已验收结果开始。
- 换目录和高级表单不会把旧 SHA 错绑到另一项目或悄悄丢失。
- stale detail、未完成、缺少或非法成果 SHA 不允许继续。
- 未知提交结果重试不新增逻辑任务；新普通项目不泄漏继续草稿。
- 旧任务、历史讨论及供应商会话没有被重新解释为当前指令。

### Task 1: Frontend continuation flow

**Files:** `web/src/BossProject.tsx`、`web/src/App.tsx`，必要的类型/样式文件，相关 Vitest 文件。

- [x] 写失败测试：完成成果按钮打开空目标表单，继承路径/偏好并固定 baseRef；无合格成果则无入口。
- [x] 运行并确认红；实现最小草稿和入口，沿用 api.createTask。
- [x] 测试换目录、连接设置返回、高级表单、不确定重试和新普通项目草稿隔离。
- [x] 跑相关/全量 web、API 测试和生产构建；报告文件与证据。

### Task 2: Real isolated workflow verification

**Files:** 新 `src/server/boss-project-continuation.test.ts`，验证记录存放 `data/verification/boss-continuation-round26`。

- [x] 使用实际 Worker、Git、Store 和 HTTP，假模型完成首个 Boss 任务并读取服务的成果提交。
- [x] 推进原项目 HEAD；以表单约定 payload 新建下一任务，验证它实际继承上次成果且没有混入原项目新变化。
- [x] 验证相同提交重试复用任务、非法/不存在 SHA 拒绝、原任务不变，最终按正常流程验收。
- [x] 独立复审前后端约定，修复具体问题，更新说明与计划勾选。
- [x] 构建与服务安全更新；HTTP 200 且 HTML 与当前构建完全一致，任务与模型验证均为空。

发布记录另存本地验证目录：提交后推送 main，读取远端 SHA 核对，记录对应 GitHub CI 状态；CI 运行中时不得记为通过。
