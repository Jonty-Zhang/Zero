[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$StageDir)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Manual-launch smoke test requires a disposable GitHub Actions Windows runner.'
}
$stage = [System.IO.Path]::GetFullPath($StageDir)
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$runnerPrefix = $runnerTemp.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$dataDir = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'zero-manual-launch-smoke'))
if (-not $dataDir.StartsWith($runnerPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $dataDir)) { throw 'Manual-launch data directory is unsafe or already exists.' }
$launcherScript = Join-Path $stage 'scripts\start-zero.ps1'
$guardianPath = Join-Path $stage 'guardian\guardian.exe'
$nodePath = Join-Path $stage 'runtime\node.exe'
foreach ($file in @($launcherScript, $guardianPath, $nodePath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Release staging lacks $file" }
    if ($file.Contains('"')) { throw 'Release staging path contains a quote.' }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$url = "http://127.0.0.1:$port/api/health"
$launcher = $null
$becameHealthy = $false
try {
    $arguments = '-NoProfile -ExecutionPolicy RemoteSigned -File "{0}" -DataDir "{1}" -Port {2}' -f $launcherScript, $dataDir, $port
    $launcherStdout = Join-Path $runnerTemp 'zero-manual-launch.stdout.log'
    $launcherStderr = Join-Path $runnerTemp 'zero-manual-launch.stderr.log'
    $launcher = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $launcherStdout -RedirectStandardError $launcherStderr
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if ($launcher.HasExited) { throw "Manual launcher exited before Zero became healthy (exit $($launcher.ExitCode))." }
        try {
            $health = Invoke-RestMethod -Uri $url -TimeoutSec 2
            if ($health.status -eq 'ok') { $becameHealthy = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $becameHealthy) { throw 'Manual launcher did not bring up the packaged Zero service within 60 seconds.' }

    $dbPath = Join-Path $dataDir 'tasks.sqlite'
    if (-not (Test-Path -LiteralPath $dbPath -PathType Leaf)) { throw 'Manual launch did not create the task database.' }
    $evidenceScript = 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});const row=db.prepare("SELECT evidence_kind,predecessor_drained FROM startup_generations ORDER BY sequence DESC LIMIT 1").get();process.stdout.write(JSON.stringify(row));db.close();'
    $evidence = & $nodePath -e $evidenceScript $dbPath | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $evidence.evidence_kind -ne 'guardian_startup_verified' -or
        $evidence.predecessor_drained -ne 1) { throw 'Manual launch did not establish verified guardian startup lineage.' }

    Stop-Process -Id $launcher.Id -Force
    $null = $launcher.WaitForExit(10000)
    $stopped = $false
    $stopDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $stopDeadline) {
        $guardians = @(Get-Process -Name guardian -ErrorAction SilentlyContinue | Where-Object {
            try { [System.String]::Equals($_.Path, $guardianPath, [System.StringComparison]::OrdinalIgnoreCase) }
            catch { $false }
        })
        $healthStillUp = $false
        try { $healthStillUp = (Invoke-RestMethod -Uri $url -TimeoutSec 1).status -eq 'ok' } catch { }
        if ($guardians.Count -eq 0 -and -not $healthStillUp) { $stopped = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $stopped) { throw 'Zero or guardian survived termination of the foreground launcher.' }
    Write-Output 'Windows manual-launch smoke test passed: default paths, health, guardian lineage, and launcher-exit cleanup.'
}
finally {
    if ($launcher) {
        try { if (-not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force } } catch { }
        $launcher.Dispose()
    }
    $guardians = @(Get-Process -Name guardian -ErrorAction SilentlyContinue | Where-Object {
        try { [System.String]::Equals($_.Path, $guardianPath, [System.StringComparison]::OrdinalIgnoreCase) }
        catch { $false }
    })
    foreach ($guardian in $guardians) {
        try { Stop-Process -Id $guardian.Id -Force } catch { }
        try { Wait-Process -Id $guardian.Id -Timeout 10 -ErrorAction SilentlyContinue } catch { }
    }
    if (Test-Path -LiteralPath $dataDir) {
        $resolvedDataDir = [System.IO.Path]::GetFullPath($dataDir)
        if (-not $resolvedDataDir.StartsWith($runnerPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to clean a directory outside RUNNER_TEMP.'
        }
        Remove-Item -LiteralPath $resolvedDataDir -Recurse -Force
    }
}
