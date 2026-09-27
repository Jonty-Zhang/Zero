function Add-CodexNativeToolsToProcessPath([string]$CodexExecutable) {
    if ([System.IO.Path]::GetFileName($CodexExecutable) -ine 'codex.exe') { return }

    $binDirectory = [System.IO.Path]::GetDirectoryName($CodexExecutable)
    if ([System.IO.Path]::GetFileName($binDirectory) -ine 'bin') { return }

    $resourcesDirectory = Join-Path (Split-Path -Parent $binDirectory) 'codex-resources'
    $sandboxSetup = Join-Path $resourcesDirectory 'codex-windows-sandbox-setup.exe'
    if (-not (Test-Path -LiteralPath $sandboxSetup -PathType Leaf)) { return }

    $env:PATH = "$binDirectory;$resourcesDirectory;$env:PATH"
}

function Set-CodexWindowsSandbox([AllowNull()][object]$Mode) {
    if ($null -eq $Mode -or ($Mode -is [string] -and $Mode.Length -eq 0)) {
        Remove-Item Env:ZERO_CODEX_WINDOWS_SANDBOX -ErrorAction SilentlyContinue
        return
    }
    if ($null -ne $Mode -and ($Mode -isnot [string] -or $Mode -notin @('elevated', 'unelevated'))) {
        throw 'CodexWindowsSandbox must be elevated or unelevated.'
    }
    Remove-Item Env:ZERO_CODEX_WINDOWS_SANDBOX -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable('ZERO_CODEX_WINDOWS_SANDBOX', ([string]$Mode).ToLowerInvariant(), 'Process')
}
