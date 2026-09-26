# Windows 手动部署

Zero 在常开 Windows 电脑上作为本机 master agent 长时间运行。需要它工作时，由用户手动启动并保持启动器窗口打开。关闭浏览器不会停止服务；关闭启动器窗口或按 Ctrl+C 会停止受监督的服务进程。Windows 开机、登录自启动、Task Scheduler 和账户密码启动均不属于当前部署方式。安装包仅为兼容旧版清理而检查或移除遗留的 `Zero Task Node` 任务，不会注册新任务。

## 安装与启动

使用 [Windows 单应用安装包](windows-app-packaging.md)中的 NSIS 安装器。安装后，开始菜单的 Zero 文件夹包含 **Start Zero**、**Zero Dashboard** 和 **Uninstall Zero** 快捷方式。安装器不会启动 Zero，也不会要求输入 Windows 账户密码。

选择 **开始菜单 → Zero → Start Zero** 手动启动。启动器窗口会保持打开。安装后也可在 PowerShell 中运行以下命令启动：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "$env:LOCALAPPDATA\Programs\Zero\scripts\start-zero.ps1"
```

需要 Zero 工作时，请保持启动器窗口打开。关闭窗口或按 Ctrl+C 可停止；机器重启后，请重新登录并手动启动。服务默认监听 `127.0.0.1:4179`；Zero Dashboard 快捷方式打开 <http://127.0.0.1:4179>。也可检查健康状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4179/api/health'
```

应返回 `status: ok`。日志按日期保存在 `%LOCALAPPDATA%\Zero\logs`。

## Harness 与服务环境

请使用已安装并登录所需 Harness CLI 的 Windows 账户启动 Zero。启动器把该用户进程的环境传给 Zero 服务。API 分配器使用 `keyEnv` 时，指定的环境变量必须在启动 Zero 时可用。凭据应保存在相应 CLI 的安全登录状态或用户环境中；不要放入命令参数、脚本、Zero 配置文件或日志。

启动器支持与 `run-zero.ps1` 相同的可选覆盖参数；不需要覆盖时使用上面的默认命令。可用的参数包括 `-CodexExe`、`-DshEntry`、`-ZcodeEntry`、`-ProxyUrl` 和 `-Port`，用于指定 CLI 可执行文件或 JavaScript 入口、代理地址或服务端口。路径必须是绝对路径。`-ProxyUrl` 仅接受不含凭据、路径、查询或片段的 HTTP(S)/SOCKS5 authority URL；代理认证应在用户环境中单独配置。CLI 路径覆盖只对本次启动的 Zero 子进程生效。

例如，需要明确指定 Codex CLI 路径时：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "$env:LOCALAPPDATA\Programs\Zero\scripts\start-zero.ps1" -CodexExe '<absolute path to codex.exe>'
```

应使用实际需要的选项。绑定验证应使用启动 Zero 时相同的 Windows 用户、数据目录、CLI 登录和环境。详见[服务端配置与绑定验证](../src/server/README.md)。

## Guardian 与恢复

原生 Windows guardian 监督 Zero 服务进程树，并为同一用户和数据目录保持单实例。启动器会在服务以非零状态退出后自动重试，退避时间从 5 秒逐步增加，最长 5 分钟；服务以状态码 0 正常退出后，启动器停止重试。若关闭启动器或中断它，重新从开始菜单或 PowerShell 启动即可。机器重启后仍需手动启动。

新 guardian 会等待旧进程 Job 中的进程全部退出，再启动新的 Zero。Zero 随后根据持久化证据执行任务恢复检查。证据不完整或不匹配的任务可能进入 `recovery_required` 等待检查；重新启动不保证每个中断任务都能自动续跑。详见[guardian 说明](../native/windows-guardian/README.md)和[崩溃恢复设计](crash-recovery-design.md)。

## 数据与卸载

默认 `%LOCALAPPDATA%\Zero` 保存 SQLite 任务数据库、本地配置、worktree、报告和日志。它与应用程序目录分离；卸载会保留该数据目录。不要将其放在公开仓库或公共共享盘中。日志当前不会自动清理，请留意磁盘空间。

卸载前，请关闭或中断 Start Zero 启动器。卸载会移除程序文件和开始菜单快捷方式，但保留 `%LOCALAPPDATA%\Zero`。重新安装后可继续使用已有任务历史和配置。

## 运维限制

- Zero 只监听本机回环地址；不要通过端口转发或防火墙规则对外开放。
- Zero 只会在用户手动启动后运行。需要 Zero 工作时，请保持电脑开机且不休眠；Windows 重启后需重新登录并手动启动。
- Harness 和验证命令以启动 Zero 的 Windows 用户身份运行。Git worktree 不是操作系统安全沙箱；只对可信仓库运行任务。
- 目标电脑上的安装、真实 Harness 执行和崩溃恢复故障注入仍待验证。
