#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("cpu", "cuda")][string]$Variant,
    [Parameter(Mandatory = $true)][string]$FFmpegDir,
    [string]$OutputDir = (Join-Path $PSScriptRoot "..\build\depth-runtime")
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitProcess) {
    throw "Windows 深度运行包必须在 64 位 Windows 上构建"
}
foreach ($tool in @("uv", "git")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "构建缺少 $tool" }
}
$ffmpegSource = (Resolve-Path -LiteralPath $FFmpegDir).Path
$media = & (Join-Path $PSScriptRoot "assert-media-runtime-windows.ps1") -Runtime $ffmpegSource

$commit = "4f5ae23172ba60fd7bc11ef671cca678842c7072"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("beeftv-depth-build-" + [guid]::NewGuid().ToString("N"))
$runtime = Join-Path $scratch "runtime"
$destination = (New-Item -ItemType Directory -Path $OutputDir -Force).FullName
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
try {
    & uv python install 3.11
    if ($LASTEXITCODE -ne 0) { throw "安装固定 Python 3.11 失败" }
    $managedPython = (& uv python find 3.11 --managed-python).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $managedPython)) { throw "找不到 uv 管理的 Windows Python 3.11" }
    $pythonRoot = Split-Path -Parent $managedPython
    $pythonStage = Join-Path $runtime ".python"
    Copy-Item -LiteralPath $pythonRoot -Destination $pythonStage -Recurse -Force
    $python = Join-Path $pythonStage "python.exe"
    $sitePackages = Join-Path $pythonStage "Lib\site-packages"
    $backend = if ($Variant -eq "cpu") { "cpu" } else { "cu128" }
    $packages = @(
        "torch==2.8.0", "torchvision==0.23.0", "numpy==2.1.3",
        "opencv-python==4.10.0.84", "pillow==11.1.0", "matplotlib==3.10.0",
        "imageio==2.37.0", "easydict==1.13",
        "einops==0.8.1", "tqdm==4.67.1"
    )
    & uv pip install --python $python --target $sitePackages --torch-backend=$backend @packages
    if ($LASTEXITCODE -ne 0) { throw "$Variant 依赖安装失败" }

    $workerDir = Join-Path $runtime "worker"
    New-Item -ItemType Directory -Path $workerDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "tools\depth-capture\depth_capture") -Destination $workerDir -Recurse
    $bin = Join-Path $runtime "bin"
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    foreach ($file in @("ffmpeg.exe", "ffprobe.exe", "LICENSE.txt", "LICENSE", "README.txt", "manifest.json")) {
        Copy-Item -LiteralPath (Join-Path $ffmpegSource $file) -Destination $bin
    }

    $sourceRepo = Join-Path $scratch "vda-source"
    & git clone --filter=blob:none --no-checkout https://github.com/DepthAnything/Video-Depth-Anything.git $sourceRepo
    if ($LASTEXITCODE -ne 0) { throw "拉取固定 VDA 源码失败" }
    & git -C $sourceRepo checkout $commit
    if ($LASTEXITCODE -ne 0 -or (& git -C $sourceRepo rev-parse HEAD).Trim() -ne $commit) {
        throw "VDA 源码提交校验失败"
    }
    $sourceArchive = Join-Path $scratch "vda-source.zip"
    & git -C $sourceRepo archive --format=zip --output=$sourceArchive $commit
    if ($LASTEXITCODE -ne 0) { throw "归档 VDA 源码失败" }
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath (Join-Path $runtime "vda")
    Set-Content -LiteralPath (Join-Path $runtime "VDA_COMMIT") -Value $commit -Encoding Ascii
    if (Test-Path -LiteralPath (Join-Path $sourceRepo "LICENSE")) {
        Copy-Item -LiteralPath (Join-Path $sourceRepo "LICENSE") -Destination (Join-Path $runtime "LICENSE-Video-Depth-Anything")
    }

    # A copied interpreter must still import its packages after relocation.
    $relocated = Join-Path $scratch "中文 path\runtime"
    New-Item -ItemType Directory -Path (Split-Path -Parent $relocated) -Force | Out-Null
    Move-Item -LiteralPath $runtime -Destination $relocated
    & (Join-Path $PSScriptRoot "test-depth-runtime-windows.ps1") -Variant $Variant -RuntimeRoot $relocated
    if ($LASTEXITCODE -ne 0) { throw "运行包搬移自检失败" }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $name = "beeftv-depth-runtime-v1-windows-amd64-$Variant.zip"
    $archivePath = Join-Path $destination $name
    if (Test-Path -LiteralPath $archivePath) { throw "目标运行包已存在，拒绝覆盖: $archivePath" }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($relocated, $archivePath)
    # Verify the final ZIP, including its receipt, before computing or publishing metadata.
    $media = & (Join-Path $PSScriptRoot "assert-media-runtime-windows.ps1") -DepthArchive $archivePath
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $count = $archive.Entries.Count
        $expandedSize = [long]0
        foreach ($item in $archive.Entries) { $expandedSize += $item.Length }
    } finally { $archive.Dispose() }
    $artifact = [ordered]@{
        name = $name
        size = (Get-Item -LiteralPath $archivePath).Length
        sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        files = $count
        expandedSize = $expandedSize
        mediaRuntime = $media
    }
    if ($artifact.size -ge 2GB) {
        # GitHub Release assets must each be smaller than 2 GiB. Keep the complete
        # archive locally for self-test; publish only these verified parts.
        $partLimit = [long](1536MB)
        $parts = @()
        $inputStream = [System.IO.File]::OpenRead($archivePath)
        try {
            $index = 0
            $buffer = New-Object byte[] (1MB)
            while ($inputStream.Position -lt $inputStream.Length) {
                $index++
                $partName = "$name.part-{0:D3}" -f $index
                $partPath = Join-Path $destination $partName
                $outputStream = [System.IO.File]::Create($partPath)
                try {
                    $remaining = [Math]::Min($partLimit, $inputStream.Length - $inputStream.Position)
                    while ($remaining -gt 0) {
                        $count = $inputStream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $remaining))
                        if ($count -le 0) { throw "分割 CUDA 运行包时过早到达文件结尾" }
                        $outputStream.Write($buffer, 0, $count)
                        $remaining -= $count
                    }
                } finally { $outputStream.Dispose() }
                $parts += [ordered]@{
                    name = $partName
                    size = (Get-Item -LiteralPath $partPath).Length
                    sha256 = (Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
        } finally { $inputStream.Dispose() }
        $artifact["parts"] = $parts
        # The full ZIP is reconstructable from the verified parts and cannot be
        # uploaded as one GitHub asset; avoid retaining another 3+ GiB copy.
        Remove-Item -LiteralPath $archivePath -Force
    }
    $artifact | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination "$name.json") -Encoding UTF8
    Write-Output $artifact
} finally {
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
