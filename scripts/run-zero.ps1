[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$LogDir,
    [ValidateRange(1, 65535)][int]$Port = 4179
)

$ErrorActionPreference = 'Stop'
$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$resolvedNodePath = [System.IO.Path]::GetFullPath($NodePath)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
$entryPoint = Join-Path $resolvedInstallDir 'dist\cli.js'

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
