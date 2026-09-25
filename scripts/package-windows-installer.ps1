[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StageDir,
    [Parameter(Mandatory = $true)][string]$MakensisPath,
    [Parameter(Mandatory = $true)][string]$OutputFile,
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string]$ProductVersion = '0.1.0'
)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stage = [System.IO.Path]::GetFullPath($StageDir)
$compiler = [System.IO.Path]::GetFullPath($MakensisPath)
$output = [System.IO.Path]::GetFullPath($OutputFile)
foreach ($path in @($stage, $compiler, $output, [System.IO.Path]::GetFullPath($NodePath))) {
    if (-not [System.IO.Path]::IsPathFullyQualified($path)) { throw "Expected an absolute path: $path" }
}
if (-not (Test-Path -LiteralPath $stage -PathType Container)) { throw "Release stage not found: $stage" }
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw "NSIS compiler not found: $compiler" }
if ($ProductVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'ProductVersion must have major.minor.patch form.' }
$outputParent = Split-Path -Parent $output
$relativeOutput = [System.IO.Path]::GetRelativePath($workspace, $output)
if ($relativeOutput -eq '..' -or $relativeOutput.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -or
    [System.IO.Path]::IsPathRooted($relativeOutput)) {
    throw 'OutputFile must be inside the Zero workspace.'
}
if (Test-Path -LiteralPath $output) { throw "OutputFile already exists; choose a new path: $output" }
$cursor = $outputParent
while ($cursor -and $cursor -ne [System.IO.Path]::GetPathRoot($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
        $entry = Get-Item -LiteralPath $cursor -Force
        if ($entry.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
            throw "Output path may not pass through a symlink or reparse point: $cursor"
        }
    }
    if ($cursor.Equals($workspace, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = Split-Path -Parent $cursor
}
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
$resolvedOutputParent = (Resolve-Path -LiteralPath $outputParent).Path
$canonicalOutput = [System.IO.Path]::GetFullPath((Join-Path $resolvedOutputParent (Split-Path -Leaf $output)))
$canonicalRelativeOutput = [System.IO.Path]::GetRelativePath($workspace, $canonicalOutput)
if ($canonicalRelativeOutput -eq '..' -or $canonicalRelativeOutput.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -or
    [System.IO.Path]::IsPathRooted($canonicalRelativeOutput)) {
    throw 'Resolved OutputFile must remain inside the Zero workspace.'
}

$verifier = Join-Path $PSScriptRoot 'verify-windows-release.mjs'
& $NodePath $verifier --stage-dir $stage
if ($LASTEXITCODE -ne 0) { throw 'Release-stage verification failed; refusing to package.' }

$script = Join-Path $workspace 'installer\zero.nsi'
& $compiler /NOCONFIG /V3 "/DSTAGE_DIR=$stage" "/DOUTPUT_FILE=$output" "/DPRODUCT_VERSION=$ProductVersion" $script
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw 'makensis failed to create the Windows installer.'
}
Write-Output "Created unsigned Windows installer: $output"
