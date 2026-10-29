#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = "Directory")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Directory")][string]$Runtime,
    [Parameter(Mandatory = $true, ParameterSetName = "DepthArchive")][string]$DepthArchive
)
$ErrorActionPreference = "Stop"
$lockPath = Join-Path $PSScriptRoot "..\licenses\ffmpeg-windows.json"
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$expected = [ordered]@{
    "ffmpeg.exe" = $lock.binarySHA256
    "ffprobe.exe" = $lock.probeSHA256
    "LICENSE.txt" = $lock.licenseSHA256
    "LICENSE" = $lock.licenseSHA256
    "README.txt" = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot "..\licenses\ffmpeg-windows-README.txt") -Algorithm SHA256).Hash.ToLowerInvariant()
    "manifest.json" = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
$archive = $null
try {
    if ($DepthArchive) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $DepthArchive).Path)
    }
    foreach ($name in $expected.Keys) {
        if ($archive) {
            $entries = @($archive.Entries | Where-Object { $_.FullName.Replace("\", "/") -ceq "bin/$name" })
            if ($entries.Count -ne 1) { throw "Expected exactly one bin/$name in depth archive" }
            $stream = $entries[0].Open()
            $hasher = [System.Security.Cryptography.SHA256]::Create()
            try {
                $actual = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
            } finally { $hasher.Dispose(); $stream.Dispose() }
        } else {
            $actual = (Get-FileHash -LiteralPath (Join-Path $Runtime $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        if ($actual -cne $expected[$name]) { throw "Pinned Windows media checksum mismatch: $name" }
    }
} finally {
    if ($archive) { $archive.Dispose() }
}
# Return the same receipt only after the actual files have been verified.
$lock
