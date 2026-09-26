[CmdletBinding()]
param(
    [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
    [string]$NodePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe'),
    [string]$GuardianPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'guardian\guardian.exe'),
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Zero'),
    [string]$LogDir,
    [string]$CodexExe,
    [string]$DshEntry,
    [string]$ZcodeEntry,
    [string]$ProxyUrl,
    [ValidateRange(1, 65535)][int]$Port = 4179
)

$ErrorActionPreference = 'Stop'

function Get-CanonicalDataDir([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $root.Length) {
        $fullPath = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    }
    return $fullPath.ToLowerInvariant()
}

function Get-GuardianLockId([string]$CanonicalPath) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($CanonicalPath)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha256.Dispose() }
}

function Quote-Argument([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'Launcher arguments may not contain quotes or line breaks.'
    }
    if ($Value.EndsWith('\', [System.StringComparison]::Ordinal)) { $Value += '\' }
    return '"' + $Value + '"'
}

$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$resolvedNodePath = [System.IO.Path]::GetFullPath($NodePath)
$resolvedGuardianPath = [System.IO.Path]::GetFullPath($GuardianPath)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
if (-not $LogDir) { $LogDir = Join-Path $resolvedDataDir 'logs' }
$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
$runScript = Join-Path $resolvedInstallDir 'scripts\run-zero.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

foreach ($file in @($resolvedNodePath, $resolvedGuardianPath, $runScript, $windowsPowerShell)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required Zero runtime file was not found: $file" }
}

$canonicalDataDir = Get-CanonicalDataDir $resolvedDataDir
$guardianLockId = Get-GuardianLockId $canonicalDataDir
$actionArguments = @(
    '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', $runScript,
    '-InstallDir', $resolvedInstallDir, '-NodePath', $resolvedNodePath,
    '-DataDir', $resolvedDataDir, '-LogDir', $resolvedLogDir, '-Port', [string]$Port
)
if ($CodexExe) { $actionArguments += @('-CodexExe', $CodexExe) }
if ($DshEntry) { $actionArguments += @('-DshEntry', $DshEntry) }
if ($ZcodeEntry) { $actionArguments += @('-ZcodeEntry', $ZcodeEntry) }
if ($ProxyUrl) { $actionArguments += @('-ProxyUrl', $ProxyUrl) }

$guardianArguments = @('--lock-id', $guardianLockId, '--', $windowsPowerShell) + $actionArguments
$quotedGuardianArguments = foreach ($argument in $guardianArguments) { Quote-Argument $argument }
$guardianArgumentLine = $quotedGuardianArguments -join ' '

Write-Host "Starting Zero at http://127.0.0.1:$Port"
Write-Host 'This window stays open while Zero is running. Press Ctrl+C to stop it.'
$retryDelaySeconds = 5
while ($true) {
    $process = Start-Process -FilePath $resolvedGuardianPath -ArgumentList $guardianArgumentLine `
        -WorkingDirectory $resolvedInstallDir -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -eq 0) { exit 0 }

    Write-Host "Zero stopped with exit code $($process.ExitCode). Restarting in $retryDelaySeconds seconds."
    Start-Sleep -Seconds $retryDelaySeconds
    $retryDelaySeconds = [Math]::Min($retryDelaySeconds * 2, 300)
}
