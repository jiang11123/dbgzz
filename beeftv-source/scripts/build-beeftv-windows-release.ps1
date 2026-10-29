#Requires -Version 5.1
<#
.SYNOPSIS
    Native Windows amd64 release entrypoint for the BeefTV Wails desktop app.

.DESCRIPTION
    Builds the same desktop source as scripts/build-beeftv-release.sh, packages
    official *.beeftv-plugin archives next to BeefTV.exe, and fails loudly when
    CGO/go-sqlite3 compiler prerequisites are missing.

    This script does not install compilers, Bun, Go, Git, WebView2, or NSIS.
    It does not run scripts/verify-beeftv-local-release.sh (that gate still owns
    local contract checks). Native compile and launch acceptance stay on Windows.

    Official docs used for tool assumptions:
    - Wails v2 build output: https://wails.io/docs/gettingstarted/building
    - Wails v2 CLI / windows/amd64 / webview2: https://wails.io/docs/reference/cli
    - Wails Windows WebView2: https://wails.io/docs/guides/windows
    - Wails install (WebView2 runtime): https://wails.io/docs/gettingstarted/installation
    - go-sqlite3 CGO/gcc: https://github.com/mattn/go-sqlite3#windows
    - Go 1.25+ Windows CGO DWARF 5 / binutils 2.37+: https://go.dev/wiki/MinimumRequirements#cgo

.OUTPUTS
    backend\cmd\desktop\build\bin\BeefTV.exe
    backend\cmd\desktop\build\bin\plugin-packages\*.beeftv-plugin
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 turns native stderr into ErrorRecords. PowerShell 7.4+
# can also honor ErrorActionPreference for native commands. Download progress
# such as "go: downloading ..." must not become a terminating error.
$PSNativeCommandUseErrorActionPreference = $false

if ($env:OS -ne "Windows_NT") {
    throw "scripts/build-beeftv-windows-release.ps1 is the native Windows entrypoint. On macOS/Linux use scripts/build-beeftv-release.sh. Cross-compiling from another OS is not native acceptance."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopDir = Join-Path $repoRoot "backend\cmd\desktop"
$pluginSourceDir = Join-Path $repoRoot "plugin-packages"
$binDir = Join-Path $desktopDir "build\bin"
$exePath = Join-Path $binDir "BeefTV.exe"
$pluginResourceDir = Join-Path $binDir "plugin-packages"
$versionFile = Join-Path $repoRoot "VERSION"
$wailsModule = "github.com/wailsapp/wails/v2/cmd/wails@v2.16.0"

& bun (Join-Path $repoRoot "scripts\package-agent-host.mjs") "windows/amd64" "--verify-runtime"
if ($LASTEXITCODE -ne 0) { throw "Bundled agent-host Node runtime validation failed" }

function Write-Step([string]$Message) {
    Write-Host $Message
}

function Get-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

# Run a native executable without treating stderr progress as failure.
# Redirected logs + ErrorActionPreference=Stop otherwise throw NativeCommandError
# before LASTEXITCODE can be inspected. True nonzero exits still fail.
function Invoke-NativeExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [object[]]$ArgumentList = @(),
        [string]$FailureMessage,
        [switch]$AllowFailure,
        [switch]$CaptureOutput
    )
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = $null
    $code = 0
    try {
        if ($CaptureOutput) {
            if ($ArgumentList.Count -gt 0) {
                $output = & $FilePath @ArgumentList
            }
            else {
                $output = & $FilePath
            }
        }
        else {
            if ($ArgumentList.Count -gt 0) {
                & $FilePath @ArgumentList
            }
            else {
                & $FilePath
            }
            $output = $null
        }
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousEap
    }
    if ($null -eq $code) {
        $code = 0
    }
    if ($code -ne 0 -and -not $AllowFailure) {
        if ([string]::IsNullOrWhiteSpace($FailureMessage)) {
            throw ("{0} failed with exit code {1}" -f $FilePath, $code)
        }
        throw ("{0} (exit code {1})" -f $FailureMessage, $code)
    }
    return @{ ExitCode = $code; Output = $output }
}

function Get-PluginSourceDirectories {
    Get-ChildItem -LiteralPath $pluginSourceDir -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName "manifest.json") -PathType Leaf
    }
}

function Get-OfficialPluginPackages([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $Directory -File -Filter "*.beeftv-plugin")
}

function Find-CgoCompiler {
    if (-not [string]::IsNullOrWhiteSpace($env:CC) -and (Test-Path -LiteralPath $env:CC -PathType Leaf)) {
        return $env:CC
    }
    foreach ($name in @("gcc", "clang")) {
        $path = Get-CommandPath $name
        if ($path) {
            return $path
        }
    }
    return $null
}

function Get-CommonCgoCompilerHints {
    $candidates = @(
        "C:\msys64\ucrt64\bin\gcc.exe",
        "C:\msys64\mingw64\bin\gcc.exe",
        "C:\msys64\clang64\bin\gcc.exe",
        "C:\mingw64\bin\gcc.exe",
        "C:\TDM-GCC-64\bin\gcc.exe"
    )
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles "mingw64\bin\gcc.exe"
    }
    if ($env:USERPROFILE) {
        $candidates += Join-Path $env:USERPROFILE "scoop\apps\gcc\current\bin\gcc.exe"
        $candidates += Join-Path $env:USERPROFILE "scoop\apps\mingw\current\bin\gcc.exe"
        $candidates += Join-Path $env:USERPROFILE "scoop\apps\msys2\current\ucrt64\bin\gcc.exe"
    }
    return @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
}

function Test-PluginZipEntries([string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        if ($names -notcontains "manifest.json") {
            throw "Plugin package $ZipPath is missing manifest.json"
        }
        foreach ($name in $names) {
            if ($name.Contains("\")) {
                throw "Plugin package $ZipPath entry '$name' uses backslash paths. BeefTV rejects those archives; zip entries must use forward slashes."
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function New-PluginZip([string]$PackageDir, [string]$OutputFile) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $roots = @("manifest.json", "README.md", "docs", "assets", "web", "backend", "LICENSE")
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($rootName in $roots) {
        $full = Join-Path $PackageDir $rootName
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $files.Add((Get-Item -LiteralPath $full))
        }
        elseif (Test-Path -LiteralPath $full -PathType Container) {
            Get-ChildItem -LiteralPath $full -Recurse -File | ForEach-Object { $files.Add($_) }
        }
    }
    if ($files.Count -eq 0) {
        throw "Plugin source $PackageDir has no packable files"
    }

    $prefixLength = $PackageDir.TrimEnd("\", "/").Length
    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($prefixLength).TrimStart("\", "/")
        $entryName = $relative.Replace("\", "/")
        $entries.Add([pscustomobject]@{ Path = $file.FullName; Name = $entryName })
    }
    $sorted = $entries.ToArray()
    [Array]::Sort($sorted, [System.Comparison[object]] { param($left, $right) [System.StringComparer]::Ordinal.Compare($left.Name, $right.Name) })

    $temporaryFile = "$OutputFile.tmp"
    if (Test-Path -LiteralPath $temporaryFile) {
        Remove-Item -LiteralPath $temporaryFile -Force
    }
    $stream = [System.IO.File]::Open($temporaryFile, [System.IO.FileMode]::Create)
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entry in $sorted) {
            $zipEntry = $archive.CreateEntry($entry.Name, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $zipEntry.Open()
            try {
                $inputStream = [System.IO.File]::OpenRead($entry.Path)
                try {
                    $inputStream.CopyTo($entryStream)
                }
                finally {
                    $inputStream.Dispose()
                }
            }
            finally {
                $entryStream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
        $stream.Dispose()
    }
    Move-Item -LiteralPath $temporaryFile -Destination $OutputFile -Force
}

function Invoke-PluginPackageBuild {
    $jsRuntime = Get-CommandPath "bun"
    if (-not $jsRuntime) {
        $jsRuntime = Get-CommandPath "node"
    }
    if (-not $jsRuntime) {
        throw "Official plugin packages are missing and neither bun nor node is available to run plugin-packages/embed-documentation.mjs"
    }

    $embedScript = Join-Path $pluginSourceDir "embed-documentation.mjs"
    $bash = Get-CommandPath "bash"
    $zip = Get-CommandPath "zip"
    $node = Get-CommandPath "node"
    $posixScript = Join-Path $pluginSourceDir "build-packages.sh"
    if ($bash -and $zip -and $node) {
        Write-Step "Building official plugin packages with plugin-packages/build-packages.sh"
        [void](Invoke-NativeExecutable -FilePath $bash -ArgumentList @($posixScript) -FailureMessage "plugin-packages/build-packages.sh failed")
        return
    }

    Write-Step "Embedding plugin documentation with $jsRuntime"
    [void](Invoke-NativeExecutable -FilePath $jsRuntime -ArgumentList @($embedScript) -FailureMessage "plugin-packages/embed-documentation.mjs failed")

    Write-Step "zip/bash/node not all available; packaging official plugins with PowerShell ZipArchive (forward-slash entries)"
    foreach ($packageDir in Get-PluginSourceDirectories) {
        $outputFile = Join-Path $pluginSourceDir ($packageDir.Name + ".beeftv-plugin")
        New-PluginZip -PackageDir $packageDir.FullName -OutputFile $outputFile
        Test-PluginZipEntries -ZipPath $outputFile
    }
}

if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
    throw "VERSION file is required"
}
$versionValue = (Get-Content -LiteralPath $versionFile -Raw).Trim()
if ($versionValue -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$') {
    throw "Invalid VERSION: $versionValue"
}

$failures = New-Object System.Collections.Generic.List[string]

$goPath = Get-CommandPath "go"
if (-not $goPath -and $env:BEEFTV_GO_DIR) {
    $bundledGo = Join-Path $env:BEEFTV_GO_DIR "bin\go.exe"
    if (Test-Path -LiteralPath $bundledGo -PathType Leaf) {
        $env:PATH = "$(Split-Path -Parent $bundledGo);$env:PATH"
        $goPath = $bundledGo
    }
}
if (-not $goPath) {
    $failures.Add("Go is required on PATH, or set BEEFTV_GO_DIR to a toolchain directory that contains bin\go.exe")
}

$bunPath = Get-CommandPath "bun"
if (-not $bunPath) {
    $failures.Add("Bun is required on PATH. wails.json frontend:install/build uses bun install --frozen-lockfile and bun run build:desktop. See https://bun.sh/")
}

if ($env:CGO_ENABLED -eq "0") {
    $failures.Add("CGO_ENABLED=0. github.com/mattn/go-sqlite3 requires CGO_ENABLED=1 and a C compiler. See https://github.com/mattn/go-sqlite3#windows")
}

$cgoCompiler = Find-CgoCompiler
if (-not $cgoCompiler) {
    $hintPaths = Get-CommonCgoCompilerHints
    $message = "No C compiler found for CGO (gcc/clang, or CC). go-sqlite3 will not build. Checked PATH and CC. This script does not install compilers or change the user PATH. See https://github.com/mattn/go-sqlite3#windows and Go 1.25+ Windows CGO DWARF 5 / binutils 2.37+ at https://go.dev/wiki/MinimumRequirements#cgo"
    if ($hintPaths.Count -gt 0) {
        $message += " A compiler exists outside PATH: $($hintPaths -join '; '). Add that bin directory to PATH for this session and rerun."
    }
    else {
        $message += " Also checked common MSYS2/MinGW/TDM-GCC/Scoop locations; none were present."
    }
    $failures.Add($message)
}

if ($failures.Count -gt 0) {
    throw ($failures -join [Environment]::NewLine)
}

$env:CC = $cgoCompiler
$env:CGO_ENABLED = "1"
if ([string]::IsNullOrWhiteSpace($env:GOTOOLCHAIN)) {
    $env:GOTOOLCHAIN = "local"
}

$goVersionResult = Invoke-NativeExecutable -FilePath "go" -ArgumentList @("env", "GOVERSION") -CaptureOutput -FailureMessage "go env GOVERSION failed"
$goVersion = ([string]$goVersionResult.Output).Trim()
if ($goVersion -match '^go1\.(\d+)') {
    $minor = [int]$Matches[1]
    if ($minor -lt 25) {
        throw "Go 1.25 or newer is required by backend/go.mod; found $goVersion"
    }
}
Write-Step "Using $goVersion at $goPath"
Write-Step "Using CGO compiler $cgoCompiler (CGO_ENABLED=1)"

$sourceDirs = @(Get-PluginSourceDirectories)
if ($sourceDirs.Count -eq 0) {
    throw "No plugin-packages/*/manifest.json sources found"
}
$existingPackages = @(Get-OfficialPluginPackages $pluginSourceDir)
if ($existingPackages.Count -eq 0) {
    Write-Step "No plugin-packages/*.beeftv-plugin artifacts found; building them"
    Invoke-PluginPackageBuild
    $existingPackages = @(Get-OfficialPluginPackages $pluginSourceDir)
}
if ($existingPackages.Count -eq 0) {
    throw "Official plugin packaging produced no *.beeftv-plugin files under plugin-packages/"
}
foreach ($package in $existingPackages) {
    Test-PluginZipEntries -ZipPath $package.FullName
}
if ($existingPackages.Count -ne $sourceDirs.Count) {
    throw "Official plugin package count does not match sources; rebuild all plugin packages before releasing."
}

$commitValue = "unknown"
$git = Get-CommandPath "git"
if ($git) {
    $gitResult = Invoke-NativeExecutable -FilePath $git -ArgumentList @("-C", $repoRoot, "rev-parse", "--short", "HEAD") -CaptureOutput -AllowFailure
    $commitText = ([string]$gitResult.Output).Trim()
    if ($gitResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($commitText)) {
        $commitValue = "unknown"
    }
    else {
        $commitValue = $commitText
    }
}
if ([string]::IsNullOrWhiteSpace($env:CANVAS_BUILD_TIME)) {
    $env:CANVAS_BUILD_TIME = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$env:CANVAS_BUILD_VERSION = $versionValue
$env:BEEFTV_DIST_PLATFORM = "windows-amd64"
$ldflags = "-X infinite-canvas/backend/internal/buildinfo.Version=$versionValue -X infinite-canvas/backend/internal/buildinfo.Commit=$commitValue -X infinite-canvas/backend/internal/buildinfo.BuildTime=$($env:CANVAS_BUILD_TIME)"
if (-not [string]::IsNullOrWhiteSpace($env:BEEFTV_UPDATER_PUBLIC_KEY)) {
    Write-Step "Injecting desktop updater FeedURL and PublicKey ldflags"
    $previousLocation = Get-Location
    Set-Location (Join-Path $repoRoot "backend")
    try {
        $ldflagsResult = Invoke-NativeExecutable -FilePath "go" -ArgumentList @("run", "./cmd/update-release", "print-ldflags") -CaptureOutput -FailureMessage "update-release print-ldflags failed. Set BEEFTV_UPDATER_PUBLIC_KEY to the base64 32-byte Ed25519 public key that matches GitHub variable BEEFTV_UPDATER_PUBLIC_KEY."
        $updaterLdflags = ([string]$ldflagsResult.Output).Trim()
        if ([string]::IsNullOrWhiteSpace($updaterLdflags)) {
            throw "update-release print-ldflags produced no output"
        }
        $ldflags = "$ldflags $updaterLdflags"
    }
    finally {
        Set-Location $previousLocation
    }
}
if (-not [string]::IsNullOrWhiteSpace($env:BEEFTV_EXTRA_LDFLAGS)) {
    $ldflags = "$ldflags $($env:BEEFTV_EXTRA_LDFLAGS.Trim())"
}

Write-Step "Building BeefTV $versionValue ($commitValue) for windows/amd64"
$appIconSource = Join-Path $repoRoot "assets\app-icon.png"
$buildDir = Join-Path $desktopDir "build"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
Copy-Item -LiteralPath $appIconSource -Destination (Join-Path $buildDir "appicon.png") -Force
$generatedWindowsIcon = Join-Path $buildDir "windows\icon.ico"
if (Test-Path -LiteralPath $generatedWindowsIcon) {
    Remove-Item -LiteralPath $generatedWindowsIcon -Force
}
Push-Location $desktopDir
try {
    $wailsArgs = @(
        "run",
        $wailsModule,
        "build",
        "-clean",
        "-trimpath",
        "-platform", "windows/amd64",
        "-webview2", "download",
        "-nosyncgomod",
        "-m",
        "-ldflags", $ldflags
    )
    [void](Invoke-NativeExecutable -FilePath "go" -ArgumentList $wailsArgs -FailureMessage "wails build failed")
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "Wails build finished but $exePath was not created. Native Windows output is required; this is not an accepted artifact."
}

if (Test-Path -LiteralPath $pluginResourceDir) {
    Remove-Item -LiteralPath $pluginResourceDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $pluginResourceDir | Out-Null
foreach ($package in Get-OfficialPluginPackages $pluginSourceDir) {
    Copy-Item -LiteralPath $package.FullName -Destination (Join-Path $pluginResourceDir $package.Name) -Force
}
$copied = @(Get-OfficialPluginPackages $pluginResourceDir)
if ($copied.Count -eq 0) {
    throw "Failed to copy official plugin packages next to $exePath"
}

Invoke-NativeExecutable -FilePath "bun" -ArgumentList @((Join-Path $repoRoot "scripts\package-agent-host.mjs"), "windows/amd64", (Join-Path $binDir "agent-host")) -FailureMessage "Agent host packaging failed" | Out-Null

# Keep media inside the sidecar tree accepted by already released updaters.
& (Join-Path $repoRoot "scripts\package-media-runtime-windows.ps1") -Destination (Join-Path $binDir "agent-host\media-runtime")
& (Join-Path $repoRoot "scripts\test-media-runtime-windows.ps1") -Runtime (Join-Path $binDir "agent-host\media-runtime")
Invoke-NativeExecutable -FilePath "bun" -ArgumentList @((Join-Path $repoRoot "scripts\distribution-notices.mjs"), "windows-amd64", (Join-Path $binDir "agent-host\licenses"), $versionValue) -FailureMessage "License packaging failed" | Out-Null

# The beeftv CLI ships with the app. External agents (Codex, Claude Code,
# Cursor) connect through it with their own client credential, so the installed
# app must carry it; it is not expected on the user PATH.
#
# It goes in a cli subdirectory, not directly next to BeefTV.exe: Windows file
# names are case-insensitive, so beeftv.exe beside BeefTV.exe is the same name.
$cliDir = Join-Path $binDir "cli"
New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
$cliPath = Join-Path $cliDir "beeftv.exe"
Push-Location (Join-Path $repoRoot "backend")
try {
    [void](Invoke-NativeExecutable -FilePath "go" -ArgumentList @("build", "-trimpath", "-ldflags", $ldflags, "-o", $cliPath, "./cmd/beeftv") -FailureMessage "beeftv CLI build failed")
}
finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "beeftv CLI was not built next to $exePath"
}

Write-Host "Release executable: $exePath"
Write-Host "Bundled agent CLI: $cliPath"
Write-Host "Official plugins: $pluginResourceDir ($($copied.Count) packages)"
Write-Host "Launch data directory (unless CANVAS_DESKTOP_DATA_DIR is set): %AppData%\BeefTV"
Write-Host "Official plugins are loaded from the executable directory, not from the process working directory."
Write-Host "WebView2 is required at runtime; Windows 11 usually already has it. Missing runtimes use Wails -webview2 download. See https://wails.io/docs/guides/windows"
Write-Host "This machine still has to launch BeefTV.exe before the Windows build is accepted. NSIS installer output is not produced."
