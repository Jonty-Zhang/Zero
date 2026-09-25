[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallerPath)

$ErrorActionPreference = 'Stop'
$installer = [System.IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer not found: $installer" }
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This smoke test only runs on a disposable GitHub Actions runner.' }
if (-not $env:RUNNER_TEMP -or -not [System.IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP)) {
    throw 'RUNNER_TEMP must be an absolute path.'
}
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$runnerTempPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

$envRoot = Join-Path $runnerTemp 'zero-installer-smoke-env'
if (Test-Path -LiteralPath $envRoot) { throw "Smoke-test environment path already exists: $envRoot" }
$resolvedEnvRoot = [System.IO.Path]::GetFullPath($envRoot)
if (-not $resolvedEnvRoot.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Smoke-test environment path escaped RUNNER_TEMP.'
}
New-Item -ItemType Directory -Path $envRoot -Force | Out-Null
$oldEnvironment = @{}
foreach ($name in @('HOME', 'APPDATA', 'LOCALAPPDATA')) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    $target = Join-Path $envRoot $name
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    [Environment]::SetEnvironmentVariable($name, $target, 'Process')
}

# NSIS uses the current Windows user's shell folders. GitHub-hosted Windows
# runners are disposable; refuse to interact with any pre-existing Zero state.
$shellLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$programDir = Join-Path $shellLocalAppData 'Programs\Zero'
$dataDir = Join-Path $shellLocalAppData 'Zero'
$marker = Join-Path $dataDir '.installer-smoke-retain-check'
$markerCreated = $false
$registryKey = 'HKCU:\Software\Zero\Installer'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero'
$startMenu = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) 'Zero'

function Invoke-BoundedProcess([string]$FilePath, [string[]]$ArgumentList, [string]$Phase, [int]$TimeoutSeconds = 120) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait:$false -PassThru -WindowStyle Hidden
    try {
        $completed = $process.WaitForExit($TimeoutSeconds * 1000)
        if (-not $completed) {
            try {
                if (-not $process.HasExited) { $process.Kill($true) }
            }
            catch { Write-Warning "Could not terminate the $Phase process tree: $($_.Exception.Message)" }
            $null = $process.WaitForExit(10000)
            throw "Windows installer smoke test timed out during $Phase after $TimeoutSeconds seconds; terminated only the process tree started for this phase."
        }
        if ($process.ExitCode -ne 0) { throw "$Phase exited with code $($process.ExitCode)." }
    }
    finally { $process.Dispose() }
}

try {
    if ((Test-Path -LiteralPath $programDir) -or (Test-Path -LiteralPath $registryKey) -or
        (Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $startMenu) -or
        (Get-ScheduledTask -TaskName 'Zero Task Node' -ErrorAction SilentlyContinue)) {
        throw 'Runner already contains Zero state; refusing to overwrite it.'
    }
    if (Test-Path -LiteralPath $dataDir) { throw 'Runner already contains %LOCALAPPDATA%\Zero; refusing to touch it.' }
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Set-Content -LiteralPath $marker -Value 'retain this smoke-test data' -NoNewline
    $markerCreated = $true

    Invoke-BoundedProcess -FilePath $installer -ArgumentList @('/S') -Phase 'install'
    foreach ($required in @('manifest.json', 'runtime\node.exe', 'guardian\guardian.exe', 'dist\cli.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $programDir $required) -PathType Leaf)) {
            throw "Installed payload is missing $required."
        }
    }
    if (-not (Test-Path -LiteralPath $registryKey) -or -not (Test-Path -LiteralPath $uninstallKey)) {
        throw 'Installer did not write per-user install and uninstall markers.'
    }
    foreach ($shortcut in @('Zero Dashboard.url', 'Configure Zero Background Service.lnk', 'Uninstall Zero.lnk')) {
        if (-not (Test-Path -LiteralPath (Join-Path $startMenu $shortcut) -PathType Leaf)) {
            throw "Start Menu shortcut is missing: $shortcut"
        }
    }
    if (Get-ScheduledTask -TaskName 'Zero Task Node' -ErrorAction SilentlyContinue) {
        throw 'Installer registered a scheduled task without explicit user action.'
    }

    $uninstaller = Join-Path $programDir 'uninstall.exe'
    Invoke-BoundedProcess -FilePath $uninstaller -ArgumentList @('/S') -Phase 'uninstall'
    if (Test-Path -LiteralPath $programDir) { throw 'Uninstaller left program files behind.' }
    if ((Test-Path -LiteralPath $registryKey) -or (Test-Path -LiteralPath $uninstallKey)) {
        throw 'Uninstaller left install registry markers behind.'
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'Uninstaller deleted runtime data; expected it to be retained.'
    }
    if (Test-Path -LiteralPath (Join-Path $startMenu 'Configure Zero Background Service.lnk')) {
        throw 'Uninstaller left a Start Menu shortcut behind.'
    }
    Write-Output 'Windows installer smoke test passed: install, shortcuts, no implicit task, uninstall, and data retention.'
}
finally {
    if ($markerCreated -and (Test-Path -LiteralPath $marker)) { Remove-Item -LiteralPath $marker -Force }
    if ($markerCreated -and (Test-Path -LiteralPath $dataDir)) {
        $remaining = @(Get-ChildItem -LiteralPath $dataDir -Force -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $dataDir -Force }
    }
    foreach ($name in @('HOME', 'APPDATA', 'LOCALAPPDATA')) {
        [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
    }
    $cleanupRoot = [System.IO.Path]::GetFullPath($envRoot)
    if (-not $cleanupRoot.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clean a path outside RUNNER_TEMP.'
    }
    if (Test-Path -LiteralPath $envRoot) { Remove-Item -LiteralPath $envRoot -Recurse -Force }
}
