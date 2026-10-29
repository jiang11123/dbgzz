#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$Runtime)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Native Windows acceptance required" }
$Runtime = (Resolve-Path -LiteralPath $Runtime).Path
$root = Split-Path -Parent $PSScriptRoot
$unicodeFixture = [string]([char]0x4e2d) + [char]0x6587
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("beeftv-media-" + $unicodeFixture + " fixture-" + [guid]::NewGuid().ToString("N"))
$previousPath = $env:PATH
$previousFFmpeg = $env:CANVAS_FFMPEG_PATH
$previousFFprobe = $env:CANVAS_FFPROBE_PATH
$previousTest = $env:BEEFTV_TEST_BUNDLED_MEDIA
try {
    New-Item -ItemType Directory -Path (Join-Path $scratch "agent-host"), (Join-Path $scratch "cli") -Force | Out-Null
    Copy-Item -LiteralPath $Runtime -Destination (Join-Path $scratch "agent-host\media-runtime") -Recurse
    Push-Location (Join-Path $root "backend")
    try {
        & go test -c ./internal/playback -o (Join-Path $scratch "BeefTV.exe")
        if ($LASTEXITCODE -ne 0) { throw "Playback acceptance build failed" }
        & go test -c ./internal/asset -o (Join-Path $scratch "cli\beeftv.exe")
        if ($LASTEXITCODE -ne 0) { throw "Asset acceptance build failed" }
        & go test -c ./internal/mediatools -o (Join-Path $scratch "MediaProbe.exe")
        if ($LASTEXITCODE -ne 0) { throw "Probe acceptance build failed" }
    } finally { Pop-Location }
    $env:PATH = "$env:SystemRoot\system32;$env:SystemRoot"
    $env:CANVAS_FFMPEG_PATH = $null
    $env:CANVAS_FFPROBE_PATH = $null
    $env:BEEFTV_TEST_BUNDLED_MEDIA = "1"
    & (Join-Path $scratch "BeefTV.exe") '-test.run=^TestBundledWindowsHEVCWithoutSystemFFmpeg$' '-test.v'
    if ($LASTEXITCODE -ne 0) { throw "Bundled Windows video acceptance failed" }
    & (Join-Path $scratch "cli\beeftv.exe") '-test.run=^TestBundledMediaMetadataWithoutSystemFFprobe$' '-test.v'
    if ($LASTEXITCODE -ne 0) { throw "Bundled Windows audio acceptance failed" }
    & (Join-Path $scratch "MediaProbe.exe") '-test.run=^TestProbeLocalDoesNotFetchPlaylistURLs$' '-test.v'
    if ($LASTEXITCODE -ne 0) { throw "Bundled Windows probe network isolation failed" }
} finally {
    $env:PATH = $previousPath
    $env:CANVAS_FFMPEG_PATH = $previousFFmpeg
    $env:CANVAS_FFPROBE_PATH = $previousFFprobe
    $env:BEEFTV_TEST_BUNDLED_MEDIA = $previousTest
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
