#Requires -Version 5.1
<#
.SYNOPSIS
    Pin the Windows CGO compiler to MSYS2 UCRT64 GCC with DWARF 5 / binutils 2.37+.

.DESCRIPTION
    Go 1.25 Windows CGO produces broken binaries with older MinGW/binutils.
    GitHub-hosted runners and Chocolatey mingw often ship that incompatible
    toolchain. This script selects C:\msys64\ucrt64\bin\gcc.exe (the compiler
    scripts/build-beeftv-windows-release.ps1 already documents), verifies
    binutils >= 2.37, then exports CC and PATH for later steps.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-Versioned([string]$FilePath, [string[]]$ArgumentList) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($ArgumentList -and $ArgumentList.Count -gt 0) {
            return & $FilePath @ArgumentList
        }
        return & $FilePath
    }
    finally {
        $ErrorActionPreference = $previousEap
    }
}

$preferredRoot = "C:\msys64\ucrt64\bin"
if ($env:MSYSTEM_PREFIX) {
    $fromMsystem = Join-Path $env:MSYSTEM_PREFIX "bin"
    if (Test-Path -LiteralPath (Join-Path $fromMsystem "gcc.exe") -PathType Leaf) {
        $preferredRoot = $fromMsystem
    }
}

$gccPath = Join-Path $preferredRoot "gcc.exe"
$ldPath = Join-Path $preferredRoot "ld.exe"
if (-not (Test-Path -LiteralPath $gccPath -PathType Leaf) -or -not (Test-Path -LiteralPath $ldPath -PathType Leaf)) {
    throw @"
Windows desktop builds need MSYS2 UCRT64 GCC with DWARF 5 (binutils 2.37 or newer).
Missing $gccPath or $ldPath.
Install mingw-w64-ucrt-x86_64-gcc and mingw-w64-ucrt-x86_64-binutils, for example with msys2/setup-msys2 msystem UCRT64.
Do not use Chocolatey mingw or older tdm-gcc; Go 1.25 CGO will emit non-working executables.
"@
}

$ldOutput = Invoke-Versioned -FilePath $ldPath -ArgumentList @("--version")
$ldFirstLine = ([string]($ldOutput | Select-Object -First 1)).Trim()
if ($ldFirstLine -notmatch '(\d+)\.(\d+)') {
    throw "Could not parse binutils version from ld --version: $ldFirstLine"
}
$ldMajor = [int]$Matches[1]
$ldMinor = [int]$Matches[2]
if ($ldMajor -lt 2 -or ($ldMajor -eq 2 -and $ldMinor -lt 37)) {
    throw "ld at $ldPath reports $ldFirstLine. Go 1.25 Windows CGO requires binutils 2.37 or newer for DWARF 5. This is not an acceptable MinGW."
}

$env:PATH = "$preferredRoot;$env:PATH"
$env:CC = $gccPath
$env:CGO_ENABLED = "1"
if ($env:GITHUB_PATH) {
    Add-Content -LiteralPath $env:GITHUB_PATH -Value $preferredRoot
}
if ($env:GITHUB_ENV) {
    Add-Content -LiteralPath $env:GITHUB_ENV -Value "CC=$gccPath"
    Add-Content -LiteralPath $env:GITHUB_ENV -Value "CGO_ENABLED=1"
}

$gccVersion = ([string]((Invoke-Versioned -FilePath $gccPath -ArgumentList @("-dumpversion")) | Select-Object -First 1)).Trim()
Write-Host "Using DWARF 5 CGO compiler $gccPath (gcc $gccVersion, $ldFirstLine)"
