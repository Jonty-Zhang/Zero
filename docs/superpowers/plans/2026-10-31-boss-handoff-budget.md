# Boss Handoff Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 机器生成的重复交接内容不会使合法多阶段任务中途规划超限。

**Architecture:** BossPlanContext 独立 handoffs 字段；机器投影使用既有 bounded renderer 和独立序列化预算，真实对话校验不变。

**Spec:** `docs/2026-10-31-boss-handoff-budget.md`

- [x] 复现合法 16 阶段任务在第 10 次规划前失败。
- [x] 写真实 Worker/Boss 的 16 阶段回归，先观察失败。
- [x] 拆分机器证据，规划/咨询使用同一有界投影，保留完整原始要求。
- [x] 测试序列化预算、用户消息上限、正常和恢复流程，构建、独立复审。
- [x] 更新服务并记录原始完整测试与逐项复核结果。

发布后另存推送回执与 CI 状态；远端 SHA 必须回读一致，CI 运行中不得记为通过。
