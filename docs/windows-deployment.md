# Windows 无人值守部署

本方案使用 Windows Task Scheduler 在系统启动时运行 Zero 服务。安装脚本默认只显示配置并退出；只有明确传入 `-Install` 才会注册任务。卸载仅移除计划任务，保留数据库、配置、worktree、报告和日志。

## 运行账户与凭据

使用一个专供 Zero 的**标准权限 Windows 账户**。该账户需要读取 Zero 发布目录、访问指定仓库，并对 `ZERO_DATA_DIR` 和日志目录拥有写入权限。不要使用本机管理员账户、日常工作账户或保存了其他高权限凭据的账户。Zero 中的 harness 和测试命令会以该账户执行任意仓库代码；Git worktree 本身不是操作系统沙箱。

先登录这个账户，安装并登录 Codex CLI，然后在该账户的终端完成一次 Codex 模型绑定验证。CLI 凭据必须能在用户退出交互桌面后继续由该账户访问。Windows Hello PIN 不能代替账户密码供计划任务使用；如果该账户无法提供可用密码登录，请在任务计划程序 UI 中按组织策略配置启动凭据，不能把密码写进脚本、环境变量、任务参数或文件。

安装脚本要求当前登录用户与 `-Account` 是同一个 SID，并拒绝当前账户属于本机 Administrators 组的情况。它通过系统凭据对话框收取账户密码，将其直接交给 Task Scheduler 保存；密码不会写入文件或进程命令行。Task Scheduler 使用 Windows 保护的账户凭据运行任务。凭据轮换后需要在任务计划程序中更新凭据，或卸载后重新安装。

标准账户能否注册 `AtStartup` 触发器受本机和组织的 Task Scheduler 策略影响，必须在目标机器上实测。若标准账户注册被拒绝，由管理员仅协助在任务计划程序中创建/注册任务，并在 General → Security options 中仍选择 Zero 标准账户、选择无论用户是否登录都运行、保存该账户凭据，且保持 **Run with highest privileges 未选中**。管理员不应把任务 Principal 改成管理员，也不应以管理员权限启动 Zero 进程。注册后仍须按下方步骤验证任务实际运行身份和 loopback 服务。

## 构建和预检

在 Zero 源码目录中以该标准权限账户运行：

```powershell
npm ci
npm run build
npm --prefix web ci
npm --prefix web run build
node .\dist\cli.js help
```

安装脚本要求 Node.js 24 或更高版本，并要求 `dist\cli.js` 已构建。`-NodePath` 可显式指定 `node.exe` 的绝对路径；建议使用机器范围安装位置，例如 `C:\Program Files\nodejs\node.exe`。计划任务不依赖交互式终端里的当前目录或 PATH 来启动 Node。任务动作使用 Windows PowerShell 的 `RemoteSigned` 策略，不会覆盖机器策略；本地 `run-zero.ps1` 必须可按本机策略执行。如果从带有 Internet Zone 标记的 ZIP 或浏览器下载目录运行，先审阅文件来源，并按组织签名/解锁流程处理；不要把执行策略改成全局 `Unrestricted` 或 `Bypass`。

先执行 dry run 查看路径，不会注册任务或写系统配置：

```powershell
.\scripts\install-windows-task.ps1 -Account 'COMPUTER\zero-runner'
```

## 安装

仍在 `-Account` 指定的标准用户会话中，执行：

```powershell
.\scripts\install-windows-task.ps1 `
  -Install `
  -Account 'COMPUTER\zero-runner' `
  -NodePath 'C:\Program Files\nodejs\node.exe' `
  -CodexExe 'C:\Users\zero-runner\AppData\Local\Programs\Codex\codex.exe' `
  -DshEntry '<absolute path to the DSH JavaScript CLI entry>' `
  -ProxyUrl 'http://proxy.example:8080' `
  -DataDir 'C:\Users\zero-runner\AppData\Local\Zero' `
  -LogDir 'C:\Users\zero-runner\AppData\Local\Zero\logs' `
  -Port 4179
```

脚本先检查任务名不存在、Node 版本、账户 SID、管理员组和目录位置，再通过系统凭据对话框取得密码并注册一个有限权限的开机任务。它不会立即启动服务。默认配置如下：

| 设置 | 默认值或行为 |
|---|---|
| 触发器 | 系统启动时 |
| 任务账户 | 必须显式指定，且是当前登录的标准账户 |
| Node.js | 已验证的 Node.js 24+ 绝对路径 |
| Codex CLI | 可选；用 `-CodexExe` 指定绝对 `codex.exe` 路径，启动器会设置 `ZERO_CODEX_EXE` |
| DSH CLI | 可选；用 `-DshEntry` 指定绝对 `.js`、`.mjs` 或 `.cjs` CLI 入口，启动器会设置 `ZERO_DSH_ENTRY`。该路径会作为任务动作参数保存在 Task Scheduler 中；不要把凭据或其他秘密放进路径或参数。未指定时保留任务进程环境中已有的 `ZERO_DSH_ENTRY`。 |
| 网络代理 | 可选；`-ProxyUrl` 设置为 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`，仅接受不含凭据、路径、查询或片段的 HTTP(S)/SOCKS5 authority URL |
| `ZERO_DATA_DIR` | `%LOCALAPPDATA%\Zero`，可用 `-DataDir` 覆盖 |
| 日志目录 | `%LOCALAPPDATA%\Zero\logs`，可用 `-LogDir` 覆盖 |
| 服务监听 | `127.0.0.1:4179`，可用 `-Port` 更改端口 |
| 失败重启 | 每次失败后间隔 1 分钟，最多 3 次 |
| 运行级别 | Limited；不以管理员权限启动 |

`ZERO_DATA_DIR` 保存 `tasks.sqlite`、本地配置、任务 worktree、审核报告和 harness 日志。日志按日期写入 `zero-YYYY-MM-DD.log`。两个目录必须位于源码/构建目录之外，并由任务账户控制访问；不要把运行数据放进公开 Git 仓库或同步到公共共享盘。脚本会用当前账户测试目录可写性，但不会改变目录 ACL。

确认 Codex CLI 在该任务账户下能找到并登录。首次安装后，使用相同账户和数据目录运行绑定验证；如模型配置尚未建立，先按本地配置说明添加模型，再验证：

```powershell
$env:ZERO_DATA_DIR = 'C:\Users\zero-runner\AppData\Local\Zero'
$env:ZERO_CODEX_EXE = 'C:\Users\zero-runner\AppData\Local\Programs\Codex\codex.exe'
node .\dist\cli.js verify-binding codex gpt-6-sol
Remove-Item Env:\ZERO_DATA_DIR
Remove-Item Env:\ZERO_CODEX_EXE
```

绑定验证必须使用与计划任务相同的 Codex CLI 路径和代理出口。安装时传入 `-CodexExe`、`-ProxyUrl` 后，计划任务启动器会在每次启动时重新设置这些值，不依赖交互终端的临时环境。`-ProxyUrl` 只接受无用户信息、路径、查询或片段的 HTTP(S)/SOCKS5 authority URL；该 URL 会作为无凭据的任务参数保存。需要代理认证时，不要把凭据传给 `-ProxyUrl`，请通过组织管理的服务账户环境配置注入代理环境变量；启动器在未传 `-ProxyUrl` 时会保留这些环境变量。Zero 会在 harness 捕获的输出中脱敏代理 URL 与用户名/密码。

若代理监听器依赖交互式桌面，它可能在用户登录前尚未启动。应先配置一个能在系统启动阶段运行并监听该地址的代理服务，再启动 Zero；否则 Zero 发起的外部 CLI 调用会因代理不可达而失败。必须在重启后保持 Zero 账户退出登录的情况下复验代理监听、Zero 健康检查和一次真实模型调用。

Codex 进程在共享相同 `CODEX_HOME` 和账户时可能显示在 Codex 应用的 Recent 列表中；分配和审核会话使用 ephemeral 模式。Zero 的任务状态与报告保存在 Zero 中。Codex 应用的项目分组可能因 Zero 使用 worktree 而不同。

不要把 Codex API 密钥写入命令行、计划任务参数、脚本、`config.json` 或日志。使用 Codex CLI 支持的账户登录或安全凭据存储。计划任务使用指定账户的 profile 启动；部署验证必须确认凭据在该非交互运行环境里仍可用。

## 验证运行

安装脚本注册后，使用任务计划程序 UI 手动启动一次 `Zero Task Node`，检查服务健康状态、日志和实际模型绑定。完成这些步骤不需要先重启机器：

```powershell
Start-ScheduledTask -TaskName 'Zero Task Node'
Start-Sleep -Seconds 5
Get-ScheduledTaskInfo -TaskName 'Zero Task Node' | Format-List LastRunTime, LastTaskResult, NextRunTime
Invoke-RestMethod 'http://127.0.0.1:4179/api/health'
Get-Content 'C:\Users\zero-runner\AppData\Local\Zero\logs\zero-*.log' -Tail 80
```

健康检查应返回 `status: ok`，日志应显示服务监听 `http://127.0.0.1:4179`。`LastTaskResult` 为 `0` 通常表示任务动作正常结束；Zero 服务是常驻进程，所以运行期间任务显示 Running 是预期的。若进程很快退出，先看日志中的 Node 入口、端口冲突、配置和 CLI 登录错误。

之后重启电脑，在不登录该账户的情况下再次检查健康地址和日期日志，确认启动触发器和非交互凭据均有效。再提交一个低风险任务，检查它完成了检查、Codex 审核、返工策略和报告归档。开始无人值守运行前，确保任务仓库可信，任务账户没有管理员权限，并为日志和 worktree 预留磁盘空间。

## 卸载

以下命令默认受 PowerShell `ShouldProcess` 确认保护；`-WhatIf` 可先查看计划，不会删除任务数据：

```powershell
.\scripts\uninstall-windows-task.ps1 -TaskName 'Zero Task Node' -WhatIf
.\scripts\uninstall-windows-task.ps1 -TaskName 'Zero Task Node'
```

卸载不会删除 `ZERO_DATA_DIR`、仓库文件、worktree 或日志。正在执行的任务可能被中断；再次部署时，Zero 会对未完成的旧 worktree 采取 fail-closed 处理，需要先检查并恢复或人工清理。

## 运维限制

- v1 服务只监听 loopback，不要用端口转发或防火墙规则开放到局域网。
- 确保 Windows 电源策略不会关闭这台节点；Task Scheduler 会允许任务在电池状态下继续运行，但不能阻止系统休眠。
- 每日日志目前不会自动清理。请监控数据盘剩余空间，并按组织留存政策归档或清理日志。
- Node 安装、Codex CLI 登录或账户密码变更后，重新执行上述预检和验证。
- 如果必须使用交互式 Windows Hello、智能卡或组织登录保护，且不能为 Task Scheduler 安全配置账户密码，使用 Windows Task Scheduler UI 按组织支持的凭据方式创建启动任务；不要绕过凭据保护或把密码放入自动化文本。
