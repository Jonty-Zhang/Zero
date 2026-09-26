# Zero Windows app package

Status: the first per-user NSIS installer was built in [Windows CI](https://github.com/Jonty-Zhang/Zero/actions/runs/36148528629) and passed install/uninstall smoke tests. The release is unsigned. Target-machine installation and validation of a real Harness task remain outstanding.

## Installer behavior

CI builds and verifies the release stage with `scripts/verify-windows-release.mjs`, then compiles [`installer/zero.nsi`](../installer/zero.nsi) using `scripts/package-windows-installer.ps1`. The installer copies the manifest-checked release into the current user's `%LOCALAPPDATA%\Programs\Zero`. It adds Start Menu shortcuts for **Start Zero**, **Zero Dashboard**, and **Uninstall Zero**. The installer does not start Zero or request an account password. Runtime data is created under `%LOCALAPPDATA%\Zero` when Zero runs.

The package is for manual, foreground launch on an always-on Windows PC. The user starts Zero from Start Menu → Zero → Start Zero, or runs the installed `scripts/start-zero.ps1` launcher from PowerShell. The launcher stays visible while the guardian supervises the service process tree. Closing or interrupting the launcher stops Zero. After a nonzero service exit, the launcher retries with backoff starting at 5 seconds and increasing to at most 5 minutes; a normal exit with code 0 stops retries. Windows boot triggers, sign-in startup entries, Task Scheduler registration, and password prompts are not used. For compatibility, the installer detects a legacy `Zero Task Node` task and refuses installation while it exists; uninstall includes credential-free cleanup for a task left by an older release.

The installer supports first installation only. It refuses an existing install marker, a non-empty default program directory, or a running Zero guardian rather than overwrite program files. If copying files or creating shortcuts fails, it removes the program directory, shortcuts, and registry entries created by that attempt. Program files and runtime data are separate; uninstall removes the program and shortcuts while retaining `%LOCALAPPDATA%\Zero`.

The first version has no in-place update transaction. To update, stop Zero, uninstall the current version, and install the new version; runtime data is retained. The installer does not overwrite a non-empty install directory. Uninstall/reinstall interrupts task execution, so inspect the queue before proceeding. Guardian-backed recovery runs when Zero is manually launched again, subject to the persisted recovery evidence checks described in [Windows deployment](windows-deployment.md).

## NSIS source and verification

The installer uses NSIS MUI2. It uses the documented `RequestExecutionLevel user` and `SetShellVarContext current`: the first keeps installation at ordinary user privilege, and the second scopes Start Menu shortcuts to the current user. References: [RequestExecutionLevel](https://nsis.sourceforge.io/Reference/RequestExecutionLevel), [SetShellVarContext](https://nsis.sourceforge.io/Reference/SetShellVarContext), [NSIS downloads](https://nsis.sourceforge.io/Download), and [NSIS license](https://nsis.sourceforge.io/Docs/AppendixI.html).

CI uses the `windows-2022` GitHub-hosted runner and its preinstalled NSIS compiler. The workflow checks `makensis.exe /VERSION` and accepts `3.10` before packaging. GitHub's [Windows Server 2022 runner inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md) lists NSIS 3.10. The version check does not verify the compiler's hash or signature. If the runner image stops providing NSIS 3.10, CI fails until the version gate is reviewed. The target user's PC does not download or run NSIS or build tools. The installer is unsigned.

## CI and local build

Windows CI retains two downloadable artifacts: the unsigned release stage and `zero-windows-installer-unsigned`. Installer smoke tests point `HOME`, `APPDATA`, and `LOCALAPPDATA` at temporary directories, check that the runner has no existing Zero installation or running guardian, then perform silent install and uninstall. They check installed files and Start Menu shortcuts, verify install does not start Zero, and check that uninstall removes program files while preserving a runtime data marker. The GitHub-hosted runner is disposable; tests stop if they detect pre-existing Zero state.

Local Windows build commands (first create a release stage as documented by the release staging workflow and provide NSIS 3.10 `makensis.exe`):

```powershell
node .\scripts\verify-windows-release.mjs --stage-dir (Join-Path (Get-Location) 'release-stage')
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\package-windows-installer.ps1 `
  -StageDir (Join-Path (Get-Location) 'release-stage') `
  -MakensisPath '<NSIS 3.10 installation>\makensis.exe' `
  -OutputFile (Join-Path (Get-Location) 'installer-output\Zero-Setup-unsigned.exe') `
  -ProductVersion '0.1.0'
```

The [CI run](https://github.com/Jonty-Zhang/Zero/actions/runs/36148528629) passed NSIS compilation and install/uninstall smoke tests. These checks do not prove that Harness authentication, proxy access, or real task execution is configured on a target PC.
