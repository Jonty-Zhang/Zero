[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [string]$TaskName = 'Zero Task Node',
    [string]$Account,
    [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
    [string]$NodePath,
    [string]$CodexExe,
    [string]$ProxyUrl,
    [string]$DataDir,
    [string]$LogDir,
    [ValidateRange(1, 65535)][int]$Port = 4179
)

$ErrorActionPreference = 'Stop'

function Stop-TaskIfRunning($Task) {
    if ($Task.State -ne 'Running') { return }
    Stop-ScheduledTask -InputObject $Task
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Seconds 1
        $current = Get-ScheduledTask -TaskName $Task.TaskName -TaskPath $Task.TaskPath -ErrorAction Stop
        if ($current.State -ne 'Running') { return }
    } while ((Get-Date) -lt $deadline)
    throw "Task '$($Task.TaskName)' did not stop within 30 seconds; it was not unregistered."
}

if ($Install -and $Uninstall) { throw 'Choose either -Install or -Uninstall.' }
if (-not $Uninstall -and $CodexExe) {
    if (-not [System.IO.Path]::IsPathRooted($CodexExe)) { throw 'CodexExe must be an absolute path.' }
    $CodexExe = [System.IO.Path]::GetFullPath($CodexExe)
    if (-not (Test-Path -LiteralPath $CodexExe -PathType Leaf)) { throw "Codex executable not found: $CodexExe" }
}
if (-not $Uninstall -and $ProxyUrl) {
    $proxyUri = $null
    if (-not [Uri]::TryCreate($ProxyUrl, [UriKind]::Absolute, [ref]$proxyUri) -or
        $proxyUri.Scheme -notin @('http', 'https', 'socks5', 'socks5h') -or
        -not $proxyUri.Host -or $proxyUri.UserInfo -or $proxyUri.AbsolutePath -ne '/' -or $proxyUri.Query -or $proxyUri.Fragment) {
        throw 'ProxyUrl must be an authority-only HTTP(S) or SOCKS5 URL without user info, path, query, or fragment. Configure proxy credentials outside the task action.'
    }
}
if (-not $Install -and -not $Uninstall) {
    Write-Output 'Dry run only. Review the resolved paths, then use -Install or -Uninstall explicitly.'
    Write-Output ("Task name: {0}" -f $TaskName)
    Write-Output ("Install directory: {0}" -f [System.IO.Path]::GetFullPath($InstallDir))
    if ($Account) { Write-Output ("Task account: {0}" -f $Account) }
    if ($CodexExe) { Write-Output ("Codex executable: {0}" -f $CodexExe) }
    if ($ProxyUrl) { Write-Output 'Credential-free proxy URL: configured.' }
    return
}

if (-not $TaskName.Trim() -or $TaskName.Length -gt 128) { throw 'TaskName must contain 1 to 128 characters.' }

if ($Uninstall) {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existingTask) {
        Write-Output ("Scheduled task '{0}' is not registered; nothing to remove." -f $TaskName)
        return
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister Zero scheduled task (data and logs are retained)')) {
        Stop-TaskIfRunning $existingTask
        Unregister-ScheduledTask -InputObject $existingTask -Confirm:$false
        Write-Output ("Removed scheduled task '{0}'. Data and logs were retained." -f $TaskName)
    }
    return
}

if (-not $Account) { throw '-Account is required for installation. Use the standard Windows account that owns the Codex login.' }
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) { throw "Scheduled task '$TaskName' already exists. Review and remove it with -Uninstall before installing again." }

$resolvedInstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
$nodeCommand = if ($NodePath) { $NodePath } else { (Get-Command node -ErrorAction Stop).Source }
$resolvedNodePath = (Resolve-Path -LiteralPath $nodeCommand).Path
$entryPoint = Join-Path $resolvedInstallDir 'dist\cli.js'
$launcher = Join-Path $PSScriptRoot 'run-zero.ps1'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "Zero is not built. Run npm ci, npm run build, and build the web assets first: $entryPoint" }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Runtime launcher not found: $launcher" }

$nodeVersion = (& $resolvedNodePath --version 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.') { throw 'Could not verify the configured Node.js version.' }
if ([int]$Matches[1] -lt 24) { throw "Node.js 24 or later is required; found $nodeVersion." }

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$requestedSid = ([System.Security.Principal.NTAccount]::new($Account)).Translate([System.Security.Principal.SecurityIdentifier])
if ($requestedSid.Value -ne $currentIdentity.User.Value) {
    throw 'Run this installer while signed in as the same account specified by -Account. This keeps runtime files and credentials under that account.'
}
if (@($currentIdentity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-544') {
    throw 'The selected account is in the local Administrators group. Use a standard, low-privilege Windows account for Zero.'
}

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $DataDir) { $DataDir = Join-Path $localAppData 'Zero' }
if (-not $LogDir) { $LogDir = Join-Path $DataDir 'logs' }
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)

function Assert-OutsideInstallDirectory([string]$Path, [string]$Root) {
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $prefix = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
    if ($fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime data and logs must be outside the Zero source/build directory: $fullPath"
    }
    if ($fullPath -eq [System.IO.Path]::GetPathRoot($fullPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)) {
        throw "Refusing to use a drive root for runtime data or logs: $fullPath"
    }
}
Assert-OutsideInstallDirectory $resolvedDataDir $resolvedInstallDir
Assert-OutsideInstallDirectory $resolvedLogDir $resolvedInstallDir

if (-not $PSCmdlet.ShouldProcess($TaskName, "Register Zero at startup for $Account using Node.js $nodeVersion")) { return }

$credential = $null
$passwordBstr = [IntPtr]::Zero
$passwordPlain = $null
try {
    $credential = Get-Credential -UserName $Account -Message 'Enter this standard account password so Task Scheduler can start Zero while the account is signed out. The password is passed directly to Task Scheduler and is never written by this script.'
    if (-not $credential) { throw 'Credential entry was cancelled.' }
    $credentialSid = ([System.Security.Principal.NTAccount]::new($credential.UserName)).Translate([System.Security.Principal.SecurityIdentifier])
    if ($credentialSid.Value -ne $requestedSid.Value) { throw 'The credential prompt returned a different account than -Account.' }

    New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
    New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
    $probePath = Join-Path $resolvedDataDir ('.zero-write-check-' + [Guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($probePath, 'write check')
    Remove-Item -LiteralPath $probePath -Force
    $logProbe = Join-Path $resolvedLogDir ('.zero-write-check-' + [Guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($logProbe, 'write check')
    Remove-Item -LiteralPath $logProbe -Force

    $actionArguments = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', $launcher,
        '-InstallDir', $resolvedInstallDir, '-NodePath', $resolvedNodePath,
        '-DataDir', $resolvedDataDir, '-LogDir', $resolvedLogDir, '-Port', [string]$Port
    )
    if ($CodexExe) { $actionArguments += @('-CodexExe', $CodexExe) }
    if ($ProxyUrl) { $actionArguments += @('-ProxyUrl', $ProxyUrl) }
    $quotedArguments = foreach ($argument in $actionArguments) {
        if ($argument.Contains('"') -or $argument.Contains("`r") -or $argument.Contains("`n")) { throw 'Task action arguments may not contain quotes or line breaks.' }
        '"' + $argument + '"'
    }
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw "Windows PowerShell executable not found: $windowsPowerShell" }
    $action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument ($quotedArguments -join ' ') -WorkingDirectory $resolvedInstallDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

    $passwordBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
    $passwordPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordBstr)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -User $Account -Password $passwordPlain -RunLevel Limited `
        -Description 'Zero local task execution service. Runs as a standard user at system startup.' | Out-Null

    Write-Output ("Registered '{0}' for startup as {1}. Data: {2}; logs: {3}." -f $TaskName, $Account, $resolvedDataDir, $resolvedLogDir)
    Write-Output 'The task was registered but not started. Use the verification steps in docs/windows-deployment.md.'
}
finally {
    if ($passwordBstr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr) }
    $passwordPlain = $null
    $credential = $null
}
