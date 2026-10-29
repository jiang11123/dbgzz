#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("cpu", "cuda")][string]$Variant,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [string]$ModelRuntime
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitProcess) {
    throw "深度运行包自检需要 64 位 Windows"
}
$root = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$python = Join-Path $root ".python\python.exe"
$worker = Join-Path $root "worker"
$source = Join-Path $root "vda"
$bin = Join-Path $root "bin"
$null = & (Join-Path $PSScriptRoot "assert-media-runtime-windows.ps1") -Runtime $bin
foreach ($required in @($python, (Join-Path $worker "depth_capture\__main__.py"), (Join-Path $source "video_depth_anything\video_depth.py"), (Join-Path $bin "ffmpeg.exe"), (Join-Path $bin "ffprobe.exe"))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "深度运行包缺少文件: $required" }
}
$env:PYTHONPATH = $worker
$env:BEEFTV_VDA_SOURCE = $source
$env:PATH = "$bin;$env:PATH"
& $python -c "import torch, torchvision, cv2, numpy, depth_capture; print(torch.__version__); print(torch.version.cuda or 'cpu')"
if ($LASTEXITCODE -ne 0) { throw "深度运行包 Python 依赖加载失败" }
$ffmpegVersion = & (Join-Path $bin "ffmpeg.exe") -version
if ($LASTEXITCODE -ne 0) { throw "FFmpeg 无法启动" }
Write-Output ($ffmpegVersion | Select-Object -First 1)
$ffprobeVersion = & (Join-Path $bin "ffprobe.exe") -version
if ($LASTEXITCODE -ne 0) { throw "FFprobe 无法启动" }
Write-Output ($ffprobeVersion | Select-Object -First 1)
$mediaCheck = Join-Path ([System.IO.Path]::GetTempPath()) ("beeftv-ffmpeg-check-" + [guid]::NewGuid().ToString("N") + ".mp4")
try {
    & (Join-Path $bin "ffmpeg.exe") -y -hide_banner -loglevel error -f lavfi -i "color=black:size=64x48:rate=5:duration=0.4" -pix_fmt yuv420p $mediaCheck
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mediaCheck -PathType Leaf) -or (Get-Item -LiteralPath $mediaCheck).Length -le 0) {
        throw "搬移后的 FFmpeg 无法实际编码视频"
    }
    $dimensions = & (Join-Path $bin "ffprobe.exe") -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $mediaCheck
    if ($LASTEXITCODE -ne 0 -or $dimensions.Trim() -ne "64,48") { throw "搬移后的 FFprobe 无法读取视频" }
    # VDA reads frames with OpenCV; BeefTV writes previews with runtime/bin/ffmpeg.
    # Check the packaged path without installing imageio's second FFmpeg.
    $frameCheck = @'
import importlib.util, os, sys
assert importlib.util.find_spec('imageio_ffmpeg') is None, 'Unexpected duplicate FFmpeg wheel'
sys.path.insert(0, os.environ['BEEFTV_VDA_SOURCE'])
from utils.dc_utils import read_video_frames
frames, fps = read_video_frames(sys.argv[1], -1)
assert frames.shape == (2, 48, 64, 3), frames.shape
assert fps == 5.0, fps
'@
    & $python -c $frameCheck $mediaCheck
    if ($LASTEXITCODE -ne 0) { throw "深度运行包无法在没有 imageio-ffmpeg 时读取视频" }
} finally {
    if (Test-Path -LiteralPath $mediaCheck) { Remove-Item -LiteralPath $mediaCheck -Force }
}
if ($Variant -eq "cpu") {
    & $python -c "import torch; assert torch.version.cuda is None, 'CPU 包包含 CUDA PyTorch'"
} else {
    & $python -c "import torch; assert torch.version.cuda is not None, 'CUDA 包缺少 CUDA PyTorch'"
}
if ($LASTEXITCODE -ne 0) { throw "运行包设备变体与 PyTorch 不一致" }
if ($ModelRuntime) {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("beeftv-depth-probe-" + [guid]::NewGuid().ToString("N"))
    try {
        & (Join-Path $PSScriptRoot "probe-depth-runtime-windows.ps1") -Device $Variant -PythonPath $python -RuntimeDir $ModelRuntime -SourceDir $source -WorkDir $work -ToolDir $worker
        if ($LASTEXITCODE -ne 0) { throw "真实模型短片推理失败" }
    } finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    }
}
