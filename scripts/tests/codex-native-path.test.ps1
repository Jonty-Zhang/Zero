$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\codex-native-path.ps1')

$originalPath = $env:PATH
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "zero-codex-path-test-$PID"
try {
    $binDirectory = Join-Path $fixtureRoot 'bin'
    $resourcesDirectory = Join-Path $fixtureRoot 'codex-resources'
    New-Item -ItemType Directory -Path $binDirectory, $resourcesDirectory -Force | Out-Null
    $codexExecutable = Join-Path $binDirectory 'codex.exe'
    New-Item -ItemType File -Path $codexExecutable -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $resourcesDirectory 'codex-windows-sandbox-setup.exe') -Force | Out-Null

    $env:PATH = 'preserved-path-entry'
    Add-CodexNativeToolsToProcessPath $codexExecutable
    $expectedPrefix = "$binDirectory;$resourcesDirectory;"
    if (-not $env:PATH.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Matched native Codex layout was not prepended to process PATH in bin/resources order.'
    }
    if (-not $env:PATH.EndsWith('preserved-path-entry', [System.StringComparison]::Ordinal)) {
        throw 'Existing process PATH entries were not preserved.'
    }

    $env:PATH = 'preserved-path-entry'
    Add-CodexNativeToolsToProcessPath (Join-Path $fixtureRoot 'codex.exe')
    if ($env:PATH -ne 'preserved-path-entry') { throw 'A non-bin Codex executable changed process PATH.' }

    $otherExe = Join-Path $binDirectory 'codex.cmd'
    New-Item -ItemType File -Path $otherExe -Force | Out-Null
    Add-CodexNativeToolsToProcessPath $otherExe
    if ($env:PATH -ne 'preserved-path-entry') { throw 'A non-native Codex entry changed process PATH.' }

    Remove-Item -LiteralPath (Join-Path $resourcesDirectory 'codex-windows-sandbox-setup.exe')
    Add-CodexNativeToolsToProcessPath $codexExecutable
    if ($env:PATH -ne 'preserved-path-entry') { throw 'Codex layout without the sandbox helper changed process PATH.' }

    if ([Environment]::GetEnvironmentVariable('PATH', 'User') -ne $userPath -or
        [Environment]::GetEnvironmentVariable('PATH', 'Machine') -ne $machinePath) {
        throw 'Codex path setup changed persistent user or machine PATH.'
    }
    Write-Output 'Codex native PATH test passed: matched layout is process-scoped and other layouts are unchanged.'
}
finally {
    $env:PATH = $originalPath
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
