# Zero Windows 单应用安装包

状态：第一版按用户 NSIS 安装器已加入 CI 构建与 smoke 测试，尚待首轮 Windows CI 实际执行验证。发布产物未签名；真实目标电脑验收、自动更新事务和签名发布仍未完成。

## 安装器行为

CI 先构建并运行 `scripts/verify-windows-release.mjs`，成功后才调用 `scripts/package-windows-installer.ps1` 编译 [`installer/zero.nsi`](../installer/zero.nsi)。安装器把已经过 manifest、哈希、无额外文件和 CLI 启动检查的 release stage 放进当前 Windows 用户的 `%LOCALAPPDATA%\Programs\Zero`。它添加开始菜单中的 Zero Dashboard、本机服务配置和卸载入口；配置入口显式运行已有的 `install-windows-task.ps1`。该脚本要求标准非管理员账户，并通过 Windows 凭据提示输入 Task Scheduler 凭据。安装器本身不注册后台任务、不启动服务、不读取 Harness 凭据，也不创建 `%LOCALAPPDATA%\Zero`。

安装器只接受首次安装。如果 HKCU 安装标记、默认程序目录中的任何文件或 `Zero Task Node` 计划任务已存在，安装器会停止，不覆盖程序文件。首次复制或快捷方式创建失败时，它删除本次程序目录、快捷方式及自己的注册表项。运行数据目录与程序目录分离，卸载会保留 `%LOCALAPPDATA%\Zero`。卸载会先调用现有任务卸载脚本停止并注销 Zero 任务；若该步骤失败，程序文件会保留。

第一版没有更新事务。需要更新时，先用当前卸载入口移除程序，再安装新版本；数据目录会保留。发生安装目录非空时不可选择覆盖安装。卸载及重新安装会中断任务执行，因此请先确认队列无运行任务。签名安装器、升级期间安全停机与回滚、开机运行及断电恢复验收仍是后续发布门槛。

## NSIS 来源与校验

安装器采用 NSIS MUI2。脚本使用官方文档说明的 `RequestExecutionLevel user` 和 `SetShellVarContext current`：前者要求普通用户权限，后者把开始菜单快捷方式限定在当前用户。相关文档：[RequestExecutionLevel](https://nsis.sourceforge.io/Reference/RequestExecutionLevel)、[SetShellVarContext](https://nsis.sourceforge.io/Reference/SetShellVarContext)、[NSIS 下载页](https://nsis.sourceforge.io/Download)、[NSIS 许可证](https://nsis.sourceforge.io/Docs/AppendixI.html)。

CI 固定下载 SourceForge 上游的 NSIS 3.10 安装程序：`https://downloads.sourceforge.net/project/nsis/NSIS%203/3.10/nsis-3.10-setup.exe`，并校验 SHA-256 `4313d352e0dafd1f22b6517126a655cae3b444fa758d2845eddfbe72f24f7bdd`。此哈希来自 Npackd 的 NSIS 3.10 包元数据（[记录](https://www.npackd.org/p/net.sourceforge.nsis/3.10)），不是 NSIS 上游发布的签名校验清单。因此它能使 CI 对固定字节做完整性检查，但不是上游签名证明；不得据此宣称编译器供应链已获签名认证。目标用户电脑不会下载或执行 NSIS、PowerShell 远程脚本或其他构建工具。安装器本身也尚未签名。

## CI 与本地构建

Windows CI 会生成并保留两个可下载产物：未签名的 release stage，以及 `zero-windows-installer-unsigned` 安装器。安装器 smoke 测试在 runner 的进程环境中把 `HOME`、`APPDATA`、`LOCALAPPDATA` 指向临时目录，先检查 runner 当前 Windows 用户配置中没有既有 Zero 安装/任务/数据，再进行静默安装与卸载。测试检查已安装文件和开始菜单入口、没有隐式注册计划任务、卸载移除程序文件及保留运行数据标记；测试结束清理它创建的标记和环境目录。GitHub hosted Windows runner 是一次性环境；若出现任何预存 Zero 状态，测试会失败并停止操作。

本地 Windows 构建命令（先按 release-staging 文档完成 Node 与 guardian 产物）：

```powershell
node .\scripts\verify-windows-release.mjs --stage-dir (Join-Path (Get-Location) 'release-stage')
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\package-windows-installer.ps1 `
  -StageDir (Join-Path (Get-Location) 'release-stage') `
  -MakensisPath '<NSIS 3.10 installation>\makensis.exe' `
  -OutputFile (Join-Path (Get-Location) 'installer-output\Zero-Setup-unsigned.exe') `
  -ProductVersion '0.1.0'
```

只有 CI 中的实际 NSIS 编译和 smoke 测试通过后，安装器产物才算通过本轮构建验证。它们不证明目标电脑的计划任务密码、代理、Harness 登录或真实任务执行已经配置。
