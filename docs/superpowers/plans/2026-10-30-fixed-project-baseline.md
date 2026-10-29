# Fixed Project Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 已验收成果的接力任务不因原目录当前文件而失败或生成无用快照。

**Architecture:** 固定起点在前端跳过 prepare；Boss 服务按显式基线只读验证现有 Git 根目录与 ref，无显式基线沿用目录准备。

**Tech Stack:** React、TypeScript、Vitest、Node test、Git、SQLite、HTTP。

**Spec:** `docs/2026-10-30-fixed-project-baseline.md`

## Constraints and review focus

- 仅本仓库、假模型；不动个人配置，不增加恢复或权限分支。
- 不提升所选子目录到父 Git 根；无 Git 或 .git 符号链接必须拒绝。
- 无显式基线和新目录保持原快照行为；原 payload 的未知结果重试不变化。
- 固定基线拒绝非法/不存在的 ref，拒绝前也不能新建仓库或快照。
- 旧任务、原分支、索引与未验收本地文件保持原样。

## Task 1: Web submission

- [x] 增加失败测试，固定 SHA 时 prepare 不可用仍能提交；更新继续重试的准备次数断言。
- [x] 最小实现固定基线直接提交，普通/换目录/新建仍 prepare。
- [x] 跑相关、全量 web/API 与生产构建。

## Task 2: Read-only service validation

- [x] 真实 Worker/Git/HTTP 复现新增无关大文件导致 400。
- [x] 加服务回归覆盖只读性、错误根/无 Git/无效 ref，保留普通目录快照。
- [x] 修复显式基线入口并重跑真实接力工作流及相关后端测试。
- [x] 独立复审、记录验证。
- [x] 完整服务测试完成（25 文件、224 项通过），安全更新服务并核对 HTTP 与最终构建。

发布记录单独保存到本地验证目录：提交后推送 main 并回读远端 SHA；CI 未完成时只记录运行中，不记为通过。
