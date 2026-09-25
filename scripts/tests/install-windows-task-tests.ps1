[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GuardianPath
)

$ErrorActionPreference = 'Stop'

function Assert-Equal([string]$Actual, [string]$Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw "$Message`nExpected: $Expected`nActual:   $Actual" }
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-InstallerFailure([hashtable]$Parameters, [string]$ExpectedMessage) {
    try {
        $null = & $script:InstallerPath @Parameters
    }
    catch {
        if ($_.Exception.Message -like "*$ExpectedMessage*") { return }
        throw "Installer failed for an unexpected reason: $($_.Exception.Message)"
    }
    throw "Installer unexpectedly accepted input that should fail: $ExpectedMessage"
}

$script:InstallerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'install-windows-task.ps1'
$script:UninstallerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'uninstall-windows-task.ps1'
$resolvedGuardian = (Resolve-Path -LiteralPath $GuardianPath -ErrorAction Stop).Path

if ([System.IO.Path]::GetExtension($resolvedGuardian).ToLowerInvariant() -ne '.exe') {
    throw 'The CI guardian input must be an .exe file.'
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('zero-installer-tests-' + [Guid]::NewGuid().ToString('N'))
$resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedTempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create test files outside the system temporary directory.'
}
New-Item -ItemType Directory -Path $resolvedTempRoot | Out-Null
try {
    $dataDir = Join-Path $tempRoot 'MiXeDCaseData'
    $expectedDisplayPath = [System.IO.Path]::GetFullPath($dataDir)

    # If dry-run ever reaches task registration, this local trap fails the test.
    $script:registerScheduledTaskCalls = 0
    function Register-ScheduledTask {
        $script:registerScheduledTaskCalls++
        throw 'Dry-run attempted to register a scheduled task.'
    }

    $dryRunOutput = @(. $script:InstallerPath -GuardianPath $resolvedGuardian -DataDir $dataDir)
    $expectedDataLine = 'Zero data directory: ' + $expectedDisplayPath
    Assert-True ($dryRunOutput -ccontains $expectedDataLine) 'Dry-run did not preserve DataDir casing in its display.'
    Assert-True (($dryRunOutput -join "`n") -match 'Guardian lock ID: SHA-256 \(64 hex characters; data path is not passed to guardian\)') 'Dry-run did not report the fixed SHA-256 lock ID length.'
    Assert-Equal ([string]$script:registerScheduledTaskCalls) '0' 'Dry-run registered a scheduled task.'
    $currentAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    Assert-Equal (Resolve-TaskAccount $null) $currentAccount 'Task account default must use the current Windows identity.'
    $explicitAccount = 'EXAMPLE\provided-user'
    Assert-Equal (Resolve-TaskAccount $explicitAccount) $explicitAccount 'An explicitly configured task account must be preserved.'
    $installerSource = Get-Content -LiteralPath $script:InstallerPath -Raw
    Assert-True ($installerSource -match 'if \(\$Install\) \{ \$Account = Resolve-TaskAccount \$Account \}') 'Install flow must resolve the account before registration.'
    $nsiSource = Get-Content -LiteralPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'installer\zero.nsi') -Raw
    Assert-True ($nsiSource -match 'CreateShortcut "\$SMPROGRAMS\\Zero\\Configure Zero Background Service\.lnk"[\s\S]*?-Install -InstallDir') 'NSIS registration shortcut must call install without constructing an account name.'
    Assert-True ($nsiSource -notmatch 'Configure Zero Background Service[\s\S]{0,500}-Account') 'NSIS shortcut must not pass an account parameter.'
    Assert-True ($nsiSource -match 'uninstall-windows-task\.ps1" -Unattended') 'NSIS uninstaller must call the task helper with its non-interactive switch.'
    Assert-True ($nsiSource -notmatch 'uninstall-windows-task\.ps1"[^\r\n]*-Confirm:') 'NSIS must not pass an explicit Boolean to PowerShell -File.'

    $uninstallerSource = Get-Content -LiteralPath $script:UninstallerPath -Raw
    Assert-True ($uninstallerSource -match '\[switch\]\$Unattended') 'Task uninstaller must expose an explicit Unattended switch.'
    Assert-True ($uninstallerSource -match 'if \(\$Unattended\) \{ \$ConfirmPreference = ''None'' \}') 'Only Unattended mode should suppress ShouldProcess confirmation.'
    $safeTaskName = 'Zero Unattended Dry Run ' + [Guid]::NewGuid().ToString('N')
    $unattendedOutput = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned `
        -File $script:UninstallerPath -Unattended -TaskName $safeTaskName)
    if ($LASTEXITCODE -ne 0) { throw "Task uninstaller -File switch dry-run exited with code $LASTEXITCODE." }
    Assert-True ($unattendedOutput -ccontains "Scheduled task '$safeTaskName' is not registered; nothing to remove.") 'Unattended -File dry-run did not safely handle a missing task.'

    # Exercise the exact helper functions used by the installer without printing the ID.
    $canonicalPath = Get-CanonicalDataDir $dataDir
    $lockId = Get-GuardianLockId $canonicalPath
    Assert-True ($lockId -cmatch '^[0-9a-f]{64}$') 'Guardian lock ID must be 64 lowercase hexadecimal characters.'
    $equivalentPath = Join-Path $tempRoot 'MIXEDcasedata\.'
    $equivalentLockId = Get-GuardianLockId (Get-CanonicalDataDir $equivalentPath)
    Assert-Equal $equivalentLockId $lockId 'Equivalent case and trailing-dot paths must produce the same lock ID.'
    $expectedHash = [System.Security.Cryptography.SHA256]::Create()
    try {
        $expectedLockId = ([System.BitConverter]::ToString($expectedHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonicalPath)))).Replace('-', '').ToLowerInvariant()
    }
    finally { $expectedHash.Dispose() }
    Assert-Equal $lockId $expectedLockId 'Guardian lock ID did not match UTF-8 SHA-256 of the canonical path.'

    Assert-InstallerFailure @{ GuardianPath = 'relative-guardian.exe'; DataDir = $dataDir } 'fully qualified absolute path'

    $invalidPePath = Join-Path $tempRoot 'invalid-pe.exe'
    [System.IO.File]::WriteAllBytes($invalidPePath, [byte[]]::new(128))
    Assert-InstallerFailure @{ GuardianPath = $invalidPePath; DataDir = $dataDir } 'not a valid Windows executable'

    Write-Output 'Windows installer dry-run assertions passed.'
}
finally {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
}
