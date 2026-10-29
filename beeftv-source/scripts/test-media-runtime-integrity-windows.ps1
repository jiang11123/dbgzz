#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Runtime)
$ErrorActionPreference = "Stop"
$check = Join-Path $PSScriptRoot "assert-media-runtime-windows.ps1"
$null = & $check -Runtime $Runtime
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("beeftv-media-integrity-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch | Out-Null
function Assert-Rejected([scriptblock]$Action, [string]$Expected) {
    try { & $Action } catch {
        if ($_.Exception.Message -notlike "*$Expected*") { throw }
        return
    }
    throw "Expected rejection: $Expected"
}
try {
    $copy = Join-Path $scratch "runtime"
    Copy-Item -LiteralPath $Runtime -Destination $copy -Recurse
    foreach ($file in @("ffmpeg.exe", "ffprobe.exe", "LICENSE.txt", "LICENSE", "README.txt", "manifest.json")) {
        [IO.File]::AppendAllText((Join-Path $copy $file), "changed")
        Assert-Rejected { $null = & $check -Runtime $copy } "checksum mismatch: $file"
        Copy-Item -LiteralPath (Join-Path $Runtime $file) -Destination (Join-Path $copy $file) -Force
    }
    $badArchive = Join-Path $scratch "wrong.zip"
    Set-Content -LiteralPath $badArchive -Value "not the pinned archive"
    $destination = Join-Path $scratch "must-not-exist"
    Assert-Rejected {
        & (Join-Path $PSScriptRoot "package-media-runtime-windows.ps1") -Destination $destination -ArchivePath $badArchive
    } "archive checksum mismatch"
    if (Test-Path -LiteralPath $destination) { throw "Rejected archive created a runtime" }

    $depthRoot = Join-Path $scratch "depth"
    New-Item -ItemType Directory -Path $depthRoot | Out-Null
    Move-Item -LiteralPath $copy -Destination (Join-Path $depthRoot "bin")
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $scratch "depth.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($depthRoot, $zip)
    $null = & $check -DepthArchive $zip
    $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = @($archive.Entries | Where-Object { $_.FullName.Replace("\", "/") -ceq "bin/ffprobe.exe" })[0]
        $entry.Delete()
        $stream = $archive.CreateEntry("bin/ffprobe.exe").Open()
        try { $stream.WriteByte(0) } finally { $stream.Dispose() }
    } finally { $archive.Dispose() }
    Assert-Rejected { $null = & $check -DepthArchive $zip } "checksum mismatch: ffprobe.exe"
    Write-Host "PASS: pinned runtime, changed files, wrong upstream archive, and final depth ZIP checks"
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
