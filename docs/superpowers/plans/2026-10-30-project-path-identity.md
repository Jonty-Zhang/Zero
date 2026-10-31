# Project Path Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 等价目录写法不会丢失接力成果或分叉未知提交的身份。

**Architecture:** 用共享 hook 复用只读 folders realpath 确认，两个表单统一取 canonical 路径和有效 SHA；任务/恢复后端不变。

**Tech Stack:** React、TypeScript、Vitest、Node test、现有 HTTP API、Git。

**Spec:** `docs/2026-10-30-project-path-identity.md`

## Constraints and review focus

- 只改本仓库；无真实模型和个人配置；不新增后端端点或权限。
- 不能用全路径大小写折叠作为身份依据；真正不同的目录必须隔离。
- 原始路径精确相等不新增 RPC；普通项目、create=true/非法来源不查询。
- 确认结果按当前原始路径/create/来源 SHA 绑定，错误或旧结果不得使任务从 HEAD 提交。
- canonical 草稿和 payload 身份保持原未决提交重试；不同 SHA/目录分开。

## Task 1: Shared frontend identity and submission

- [x] 独立组件/API 复现路径写法变化导致丢 SHA、HEAD 及请求身份分叉。
- [x] 新增失败回归：Boss/高级等价路径及原请求精确重试。
- [x] 实现共享确认 hook、错误重试与两个表单接入。
- [x] 验证异步晚到、错误/非法响应、真实不同目录/create、不同 SHA、连接与高级往返。
- [x] 全量 web/API、生产构建及独立复审。

## Task 2: Actual directory evidence and publication

- [x] 实际 Windows 目录多种写法得到同一 realpath，且不建立 Git/快照。
- [x] 补实际 HTTP folders 身份回归，验证普通目录与不同目录只读性。
- [x] 构建/服务核对，记录证据。

发布时另存本地回执：提交并推送 main 后读取远端 SHA，记录新 CI 状态；运行中不得记录为通过。
