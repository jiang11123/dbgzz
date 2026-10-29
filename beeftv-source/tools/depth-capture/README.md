# BeefTV Depth Capture CLI

将普通 RGB 视频转换成近白远黑、时间连续的相对深度参考视频。第一版使用 Apache-2.0 许可的 Video Depth Anything Small 模型。

## 运行

```bash
cd tools/depth-capture
uv sync
PYTORCH_ENABLE_MPS_FALLBACK=1 uv run python -m depth_capture \
  "/path/to/input.mp4" \
  --output-dir ../../artifacts/depth-capture \
  --save-raw
```

模型代码和权重默认持久化在项目目录的 `tools/depth-capture/.cache/runtime`，不会因为 `/tmp` 清理而丢失。也可以通过 `BEEFTV_DEPTH_RUNTIME` 指定其他持久化目录。下载会先写入临时文件并校验，未完成的文件不会被当成模型使用。Apple Silicon 默认建议使用 `--input-size 280 --max-resolution 960`；CUDA 环境可提高到 `--input-size 518 --max-resolution 1280`。

## 输出

- `*_depth_preview.mp4`：8-bit H.264 灰度预览，默认 1920×1080。
- `*_depth_raw.npz`：可选的 float32 原始相对深度。
