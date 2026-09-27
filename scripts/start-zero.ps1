[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$NodePath,
    [string]$GuardianPath,
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Zero'),
    [string]$LogDir,
    [string]$CodexExe,
    [string]$DshEntry,
    [string]$ZcodeEntry,
    [string]$ProxyUrl,
    [ValidateRange(1, 65535)][int]$Port = 4179
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $scriptDirectory }
if (-not $NodePath) { $NodePath = Join-Path $InstallDir 'runtime\node.exe' }
if (-not $GuardianPath) { $GuardianPath = Join-Path $InstallDir 'guardian\guardian.exe' }

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
$entryPoint = Join-Path $resolvedInstallDir 'dist\cli.js'

foreach ($file in @($resolvedNodePath, $resolvedGuardianPath, $entryPoint)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required Zero runtime file was not found: $file" }
}
$nodeVersion = & $resolvedNodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.') { throw 'Could not verify the Node.js version.' }
if ([int]$Matches[1] -lt 24) { throw "Zero requires Node.js 24 or later; found $nodeVersion." }

if ($CodexExe) {
    if (-not [System.IO.Path]::IsPathRooted($CodexExe)) { throw 'CodexExe must be an absolute path.' }
    $resolvedCodexExe = [System.IO.Path]::GetFullPath($CodexExe)
    if (-not (Test-Path -LiteralPath $resolvedCodexExe -PathType Leaf)) { throw "Codex executable not found: $resolvedCodexExe" }
    $env:ZERO_CODEX_EXE = $resolvedCodexExe
}
if ($DshEntry) {
    if (-not [System.IO.Path]::IsPathRooted($DshEntry)) { throw 'DshEntry must be an absolute JavaScript CLI entry path.' }
    $resolvedDshEntry = [System.IO.Path]::GetFullPath($DshEntry)
    if ([System.IO.Path]::GetExtension($resolvedDshEntry).ToLowerInvariant() -notin @('.js', '.mjs', '.cjs')) {
        throw 'DshEntry must point to a .js, .mjs, or .cjs file.'
    }
    if (-not (Test-Path -LiteralPath $resolvedDshEntry -PathType Leaf)) { throw 'Configured DSH JavaScript CLI entry was not found.' }
    $env:ZERO_DSH_ENTRY = $resolvedDshEntry
}
if ($ZcodeEntry) {
    if (-not [System.IO.Path]::IsPathRooted($ZcodeEntry)) { throw 'ZcodeEntry must be an absolute JavaScript CLI entry path.' }
    $resolvedZcodeEntry = [System.IO.Path]::GetFullPath($ZcodeEntry)
    if ([System.IO.Path]::GetExtension($resolvedZcodeEntry).ToLowerInvariant() -notin @('.js', '.mjs', '.cjs')) {
        throw 'ZcodeEntry must point to a .js, .mjs, or .cjs file.'
    }
    if (-not (Test-Path -LiteralPath $resolvedZcodeEntry -PathType Leaf)) { throw 'Configured ZCode JavaScript CLI entry was not found.' }
    $env:ZERO_ZCODE_ENTRY = $resolvedZcodeEntry
}
if ($ProxyUrl) {
    $proxyUri = $null
    if (-not [Uri]::TryCreate($ProxyUrl, [UriKind]::Absolute, [ref]$proxyUri) -or
        $proxyUri.Scheme -notin @('http', 'https', 'socks5', 'socks5h') -or
        -not $proxyUri.Host -or $proxyUri.UserInfo -or $proxyUri.AbsolutePath -ne '/' -or $proxyUri.Query -or $proxyUri.Fragment) {
        throw 'ProxyUrl must be an authority-only HTTP(S) or SOCKS5 URL without user info, path, query, or fragment.'
    }
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
        [Environment]::SetEnvironmentVariable($name, $ProxyUrl, 'Process')
    }
}

New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
$env:ZERO_DATA_DIR = $resolvedDataDir
$env:ZERO_HOST = '127.0.0.1'
$env:ZERO_PORT = [string]$Port

$canonicalDataDir = Get-CanonicalDataDir $resolvedDataDir
$guardianLockId = Get-GuardianLockId $canonicalDataDir
$guardianArguments = @('--lock-id', $guardianLockId, '--parent-pid', [string]$PID, '--', $resolvedNodePath, $entryPoint, 'serve')
$quotedGuardianArguments = foreach ($argument in $guardianArguments) { Quote-Argument $argument }
$guardianArgumentLine = $quotedGuardianArguments -join ' '

Write-Host "Starting Zero at http://127.0.0.1:$Port"
Write-Host 'This window stays open while Zero is running. Press Ctrl+C to stop it.'
$retryDelaySeconds = 5
while ($true) {
    $startedAt = Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'
    $stdoutLog = Join-Path $resolvedLogDir "zero-$startedAt.stdout.log"
    $stderrLog = Join-Path $resolvedLogDir "zero-$startedAt.stderr.log"
    $process = Start-Process -FilePath $resolvedGuardianPath -ArgumentList $guardianArgumentLine `
        -WorkingDirectory $resolvedInstallDir -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    try {
        while (-not $process.WaitForExit(500)) { }
        $exitCode = $process.ExitCode
    }
    finally {
        if (-not $process.HasExited) {
            try { $process.Kill() } catch { }
            $null = $process.WaitForExit(10000)
        }
        $process.Dispose()
    }
    if ($exitCode -eq 0) { exit 0 }

    Write-Host "Zero stopped with exit code $exitCode. Logs: $stdoutLog and $stderrLog. Restarting in $retryDelaySeconds seconds."
    Start-Sleep -Seconds $retryDelaySeconds
    $retryDelaySeconds = [Math]::Min($retryDelaySeconds * 2, 300)
}
