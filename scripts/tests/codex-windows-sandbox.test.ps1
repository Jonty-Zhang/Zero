$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\codex-native-path.ps1')

$originalMode = $env:ZERO_CODEX_WINDOWS_SANDBOX
$originalCodexHome = $env:CODEX_HOME
$userMode = [Environment]::GetEnvironmentVariable('ZERO_CODEX_WINDOWS_SANDBOX', 'User')
$machineMode = [Environment]::GetEnvironmentVariable('ZERO_CODEX_WINDOWS_SANDBOX', 'Machine')
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "zero-codex-sandbox-test-$PID"
try {
    $codexHome = Join-Path $fixtureRoot 'codex-home'
    New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
    $configFile = Join-Path $codexHome 'config.toml'
    Set-Content -LiteralPath $configFile -Value "[windows]`nsandbox = 'elevated'"
    $configHash = (Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash
    $env:CODEX_HOME = $codexHome

    $env:ZERO_CODEX_WINDOWS_SANDBOX = 'elevated'
    Set-CodexWindowsSandbox $null
    if (Test-Path Env:ZERO_CODEX_WINDOWS_SANDBOX) { throw 'Omitting the option did not leave the process sandbox mode unset.' }

    Set-CodexWindowsSandbox 'unelevated'
    if ($env:ZERO_CODEX_WINDOWS_SANDBOX -ne 'unelevated') { throw 'Sandbox mode was not set for this process.' }
    try {
        Set-CodexWindowsSandbox 'danger-full-access'
        throw 'An invalid Codex Windows sandbox mode was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'An invalid Codex Windows sandbox mode was accepted.') { throw }
        if ($env:ZERO_CODEX_WINDOWS_SANDBOX -ne 'unelevated') { throw 'Invalid input changed the process sandbox mode.' }
    }

    if ([Environment]::GetEnvironmentVariable('ZERO_CODEX_WINDOWS_SANDBOX', 'User') -ne $userMode -or
        [Environment]::GetEnvironmentVariable('ZERO_CODEX_WINDOWS_SANDBOX', 'Machine') -ne $machineMode) {
        throw 'Codex sandbox option changed persistent user or machine environment.'
    }
    if ((Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash -ne $configHash -or
        @(Get-ChildItem -LiteralPath $codexHome -Force).Count -ne 1) {
        throw 'Codex sandbox option changed or added a Codex config file.'
    }
    Write-Output 'Codex Windows sandbox test passed: validated process-only setting; user/machine environment and Codex config unchanged.'
}
finally {
    if ($null -eq $originalMode) { Remove-Item Env:ZERO_CODEX_WINDOWS_SANDBOX -ErrorAction SilentlyContinue }
    else { $env:ZERO_CODEX_WINDOWS_SANDBOX = $originalMode }
    if ($null -eq $originalCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
    else { $env:CODEX_HOME = $originalCodexHome }
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
