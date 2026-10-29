#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$ArchivePath = $env:BEEFTV_WINDOWS_MEDIA_ARCHIVE
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($env:OS -ne "Windows_NT") { throw "Native Windows packaging is required" }
$lockPath = Join-Path $PSScriptRoot "..\licenses\ffmpeg-windows.json"
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath $Destination) { throw "Refusing to overwrite media runtime: $Destination" }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("beeftv-media-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    if (-not $ArchivePath) {
        $ArchivePath = Join-Path $scratch "upstream.zip"
        Invoke-WebRequest -Uri $lock.archiveURL -OutFile $ArchivePath -UseBasicParsing
    }
    if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.archiveSHA256) { throw "FFmpeg archive checksum mismatch" }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath (Join-Path $scratch "unpacked")
    $upstream = Join-Path (Join-Path $scratch "unpacked") $lock.archiveRoot
    $stage = Join-Path $scratch "media-runtime"
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item -LiteralPath (Join-Path $upstream "bin\ffmpeg.exe") -Destination $stage
    Copy-Item -LiteralPath (Join-Path $upstream "bin\ffprobe.exe") -Destination $stage
    Copy-Item -LiteralPath (Join-Path $upstream "LICENSE.txt") -Destination $stage
    # Released updaters require these names; retain the original license too.
    Copy-Item -LiteralPath (Join-Path $upstream "LICENSE.txt") -Destination (Join-Path $stage "LICENSE")
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\licenses\ffmpeg-windows-README.txt") -Destination (Join-Path $stage "README.txt")
    Copy-Item -LiteralPath $lockPath -Destination (Join-Path $stage "manifest.json")
    $null = & (Join-Path $PSScriptRoot "assert-media-runtime-windows.ps1") -Runtime $stage
    $binary = Join-Path $stage "ffmpeg.exe"
    $info = & $binary -version
    if ($LASTEXITCODE -ne 0 -or $info[0] -notmatch ("^ffmpeg version " + [regex]::Escape($lock.runtimeVersion) + " ")) { throw "Unexpected FFmpeg runtime" }
    $probe = Join-Path $stage "ffprobe.exe"
    $probeInfo = & $probe -version
    if ($LASTEXITCODE -ne 0 -or $probeInfo[0] -notmatch ("^ffprobe version " + [regex]::Escape($lock.runtimeVersion) + " ")) { throw "Unexpected FFprobe runtime" }
    # Relocated native conversion works with no globally installed media tools.
    & $binary -nostdin -hide_banner -loglevel error -f lavfi -i "color=c=red:s=64x48:r=5:d=0.4" -threads 2 -c:v libx264 -pix_fmt yuv420p -y (Join-Path $scratch "probe.mp4")
    if ($LASTEXITCODE -ne 0) { throw "Bundled FFmpeg H.264 smoke failed" }
    $facts = & $probe -v error -protocol_whitelist file,pipe -show_entries stream=width,height:format=duration -of json (Join-Path $scratch "probe.mp4")
    if ($LASTEXITCODE -ne 0) { throw "Bundled FFprobe smoke failed" }
    $facts = ($facts -join "`n") | ConvertFrom-Json
    if ($facts.streams[0].width -ne 64 -or $facts.streams[0].height -ne 48 -or [double]$facts.format.duration -le 0) { throw "Bundled FFprobe returned invalid metadata" }
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($Destination))) -Force | Out-Null
    Copy-Item -LiteralPath $stage -Destination $Destination -Recurse
    Write-Host "Packaged FFmpeg $($lock.runtimeVersion) ($((Get-Item -LiteralPath $binary).Length) bytes)"
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
