# Writer Validation Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development.

**Goal:** 把 Boss 已确定的真实验收命令完整交给实现与返工 agent。

**Architecture:** 共用 writer prompt 附加当前检查定义 JSON，保留参数边界；失败简报按编号关联，避免重复命令。无新模型调用、恢复分支或权限。

**Spec:** `docs/2026-10-31-writer-validation-contract.md`

- [x] 真实 Worker 回归证明当前实现和返工请求缺少精确 argv。
- [x] 共用 writer 边界传递检查定义，失败简报按编号关联。
- [x] 验证 Boss/接力/返工/额度恢复，最终版本构建及针对性回归通过。
- [x] 核对服务并记录本地证据。

发布前完成独立复审；提交后推送 main 并读取远端 SHA，另存对应 CI 运行状态，不把运行中记为通过。
