# Zero Windows 单应用交付决策

状态：实施方向；安装包尚未构建或在目标机器验收。

当前已有 `scripts/stage-windows-release.mjs`，从显式指定的 Windows `node.exe`、Node 发行版 `LICENSE`、经过测试的 `guardian.exe` 和已构建的 Zero 运行文件制作发布目录与 SHA-256 清单。`scripts/verify-windows-release.mjs` 独立核对清单、拒绝额外文件，并用包内 Node 启动包内 Zero CLI。公开 CI 运行这些非安装测试并保留**未签名、非安装包**的发布目录产物。脚本要求输出目录位于 Zero 工作区内且为空，不收录本地配置、数据库、日志、测试文件或 Harness 凭据。

## 决定

Zero 作为**一个可下载安装的 Windows 产品**交付。第一版安装包包含固定版本的 Node.js 运行时、编译后的 Zero 服务与 CLI、React 界面静态文件、原生 `guardian.exe` 和启动脚本。安装后只有一个 Zero 入口与一个本机任务看板；关闭看板不影响后台任务。运行时保留服务、guardian 和 Harness 子进程的明确职责，任务数据库、配置、worktree、报告和日志放在 `%LOCALAPPDATA%\Zero`，位于可替换的程序目录之外。

安装器选用 **NSIS MUI2 的按用户安装模式**，使用 [`RequestExecutionLevel user`](https://nsis.sourceforge.io/Reference/RequestExecutionLevel) 和当前用户的 shell 目录，并集成已有的 Task Scheduler 注册脚本。NSIS 的[官方许可证](https://nsis.sourceforge.io/Docs/AppendixI.html)允许这类分发。计划任务由用户指定的标准账户运行；首次配置可提示输入该账户凭据，安装器不能把密码写入命令行、日志或仓库。安装、更新和卸载必须分别验证：首次安装创建快捷方式与任务；更新先停受控进程树再替换程序文件，保留运行数据；卸载移除任务和程序文件，默认保留运行数据。安装包和 guardian 的签名、版本钉住与来源校验属于发布门槛。

这是一项**交付方案**，不代表现有 `scripts/install-windows-task.ps1` 已能完成安装包升级或真实开机验收。Codex、ZCode、DSH 的可执行文件和认证仍由目标账户持有，Zero 不复制或修改用户的 Harness 配置。

## 选择依据

- 当前 Zero 已把 Node 服务、Web 看板和 CLI 分离；服务在浏览器关闭后继续工作。把已验证的组件打包，可以尽早获得单一安装入口与稳定后台生命周期。
- Electron 可以提供桌面窗口，但其[进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)和[打包机制](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)不会替代 Zero 的开机任务与 guardian。若后续需要原生窗口，可以在保持服务协议不变的前提下增加轻量桌面客户端。
- Tauri 支持[外部 sidecar](https://v2.tauri.app/develop/sidecar/)和[Windows 安装包](https://v2.tauri.app/distribute/windows-installer/)，但 Node 服务仍需独立的无人值守生命周期。第一版先完成安装、更新及开机实测，再决定是否加入窗口外壳。
- Node 的[单文件可执行程序](https://nodejs.org/api/single-executable-applications.html)仍需要处理当前 ESM 服务、Web 资源、原生模块与 Harness 子进程；它不会消除 guardian 或 Windows 账户配置。

## 实施与验收

1. 制作可复现的 Windows 发布目录：固定版本 Node runtime、`dist/`、`web/dist/`、guardian、脚本及许可证；CI 验证文件清单、哈希和敏感信息扫描。
2. 构建一个按用户安装包。明确程序目录与运行数据目录；配置本机 UI 快捷方式、CLI 入口和安装/卸载命令。安装流程复用经过验证的 `-GuardianPath` 与 `-NodePath` 参数，不猜测用户的 Harness 路径或提供方。
3. 设计更新事务：停计划任务，等待 guardian 和 Job 退出；备份现有程序版本，替换后做健康检查，失败则回滚程序文件；数据库迁移必须向前兼容并保留数据。
4. 在目标标准账户下验收关机重启、未登录时启动、代理连通、订阅凭据可用性、一个真实任务的分配/执行/审核，以及额度等待后的继续。安装包本身不证明这些外部条件已经满足。

参考：[Microsoft `Register-ScheduledTask`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask)、[Tauri Windows 签名](https://v2.tauri.app/distribute/sign/windows/)、[Electron Windows 更新](https://www.electronjs.org/docs/latest/api/auto-updater)。

构建发布目录时先运行 `npm ci && npm run build` 与 `npm --prefix web ci && npm --prefix web run build`，再在 Windows 上执行：

```powershell
node .\scripts\stage-windows-release.mjs `
  --node-exe '<absolute path to pinned node.exe>' `
  --node-license '<absolute path to that Node distribution LICENSE>' `
  --guardian-exe '<absolute path to tested guardian.exe>' `
  --output-dir '<empty directory under this workspace>'
node .\scripts\verify-windows-release.mjs --stage-dir '<that staged directory>'
```

构建清单可设置 `SOURCE_DATE_EPOCH` 固定生成时间；清单中的每个文件都有相对路径、字节数与 SHA-256。Node 和 guardian 路径必须是可执行 PE 文件；这项格式检查不是代码签名或来源证明。正式发布仍需钉住 Node 发行版哈希、签名安装包与 guardian，并在干净机器上验收。
