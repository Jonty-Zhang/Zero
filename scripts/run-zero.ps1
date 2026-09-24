[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$LogDir,
    [string]$CodexExe,
    [string]$ProxyUrl,
    [ValidateRange(1, 65535)][int]$Port = 4179
)

$ErrorActionPreference = 'Stop'
$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$resolvedNodePath = [System.IO.Path]::GetFullPath($NodePath)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
$entryPoint = Join-Path $resolvedInstallDir 'dist\cli.js'

if ($CodexExe) {
    if (-not [System.IO.Path]::IsPathRooted($CodexExe)) { throw 'CodexExe must be an absolute path.' }
    $resolvedCodexExe = [System.IO.Path]::GetFullPath($CodexExe)
    if (-not (Test-Path -LiteralPath $resolvedCodexExe -PathType Leaf)) { throw "Codex executable not found: $resolvedCodexExe" }
    $env:ZERO_CODEX_EXE = $resolvedCodexExe
}
if ($ProxyUrl) {
    $proxyUri = $null
    if (-not [Uri]::TryCreate($ProxyUrl, [UriKind]::Absolute, [ref]$proxyUri) -or
        $proxyUri.Scheme -notin @('http', 'https', 'socks5', 'socks5h') -or
        -not $proxyUri.Host -or $proxyUri.UserInfo -or $proxyUri.AbsolutePath -ne '/' -or $proxyUri.Query -or $proxyUri.Fragment) {
        throw 'ProxyUrl must be an authority-only HTTP(S) or SOCKS5 URL without user info, path, query, or fragment. Configure proxy credentials outside the task action.'
    }
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:ALL_PROXY = $ProxyUrl
    $env:http_proxy = $ProxyUrl
    $env:https_proxy = $ProxyUrl
    $env:all_proxy = $ProxyUrl
}

if (-not (Test-Path -LiteralPath $resolvedNodePath -PathType Leaf)) { throw "Node executable not found: $resolvedNodePath" }
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "Zero entry point not found. Build the project first: $entryPoint" }
$nodeVersion = & $resolvedNodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.') { throw 'Could not verify the Node.js version.' }
if ([int]$Matches[1] -lt 24) { throw "Zero requires Node.js 24 or later; found $nodeVersion." }

New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
$env:ZERO_DATA_DIR = $resolvedDataDir
$env:ZERO_HOST = '127.0.0.1'
$env:ZERO_PORT = [string]$Port

$logFile = Join-Path $resolvedLogDir ("zero-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
Set-Location -LiteralPath $resolvedInstallDir
"[$(Get-Date -Format o)] Starting Zero with Node.js at $resolvedNodePath" | Add-Content -LiteralPath $logFile -Encoding UTF8
& $resolvedNodePath $entryPoint serve *>> $logFile
$exitCode = $LASTEXITCODE
"[$(Get-Date -Format o)] Zero exited with code $exitCode" | Add-Content -LiteralPath $logFile -Encoding UTF8
exit $exitCode
