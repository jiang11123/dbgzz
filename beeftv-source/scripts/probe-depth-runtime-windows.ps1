#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("cpu", "cuda")]
    [string]$Device,
    [Parameter(Mandatory = $true)]
    [string]$PythonPath,
    [Parameter(Mandatory = $true)]
    [string]$RuntimeDir,
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,
    [Parameter(Mandatory = $true)]
    [string]$WorkDir,
    [string]$ToolDir = (Join-Path $PSScriptRoot "..\tools\depth-capture")
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT" -or [Environment]::Is64BitProcess -ne $true) {
    throw "深度运行包探针需要 64 位 Windows 进程"
}

$python = (Resolve-Path -LiteralPath $PythonPath).Path
$runtime = (Resolve-Path -LiteralPath $RuntimeDir).Path
$source = (Resolve-Path -LiteralPath $SourceDir).Path
$tool = (Resolve-Path -LiteralPath $ToolDir).Path
$checkpoint = Join-Path $runtime "checkpoints\video_depth_anything_vits.pth"
$modelHash = "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609"
if (-not (Test-Path -LiteralPath (Join-Path $source "video_depth_anything\video_depth.py"))) {
    throw "缺少固定版本的 Video Depth Anything 源码"
}
if (-not (Test-Path -LiteralPath $checkpoint)) {
    throw "缺少已安装的 Small 模型权重；探针不会下载模型"
}
if ((Get-FileHash -LiteralPath $checkpoint -Algorithm SHA256).Hash.ToLowerInvariant() -ne $modelHash) {
    throw "Small 模型权重 SHA-256 不匹配；探针不会执行损坏的权重"
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$env:BEEFTV_VDA_SOURCE = $source
$env:PYTHONPATH = $tool
$env:PYTHONIOENCODING = "utf-8"
& $python -m depth_capture.probe --device $Device --runtime-dir $runtime --work-dir $WorkDir
if ($LASTEXITCODE -ne 0) {
    throw "深度运行包 $Device 真实推理探针失败，退出码 $LASTEXITCODE"
}
