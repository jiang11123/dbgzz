# Intel Mac DMG 创建失败复核

旧集成 `364e59b0` 与后续版本的 Intel runner 均已通过应用构建、签名和随包媒体工具的原生验收，随后在 `package-desktop-installer.py` 的 `hdiutil create -srcfolder ... -format UDZO` 返回 `Resource busy`。这说明失败属于 DMG 容器创建阶段，不能归因到 ffprobe。现有日志没有设备操作详细阶段或占用进程，尚不能证明具体是 Spotlight、XProtect 或其他系统进程。

## 已核实的差异

Apple 随系统提供的 `hdiutil(1)` 说明：`-srcfolder` 尽量匹配源文件系统，除非显式传入 `-fs`；当前系统默认 APFS。安全临时目录实验中，原打包命令实际产生 `Apple_APFS` 镜像，并通过校验。

成熟 CMake CPack 的 DragNDrop 实现显式默认使用 HFS+，并把该文件系统传给 `hdiutil create`：[固定源码](https://github.com/Kitware/CMake/blob/2918f600a226152071d69b764556604a72014cb9/Source/CPack/cmCPackDragNDropGenerator.cxx#L269)。Apple 的[发行打包文档](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)也使用 `ditto` 保存应用目录，再调用 `hdiutil create`；现有 Python 的基本流程符合该建议。

Electron Builder 和 Apple-Actions 的打包实现将 `Resource busy` 视为可短暂出现的系统错误。该信息支持环境竞争这一假设，不能证明本次 Intel runner 的确切占用者。本次没有照搬重试、终止系统进程或卸载其他设备。

## 最小候选修复与证据

打包命令明确使用 `-fs HFS+ -nospotlight`：固定发行镜像文件系统，并禁止为本镜像创建 Spotlight 索引。`-verbose` 为后续 CI 保留创建和卸载阶段的原始诊断；所有错误继续立即返回失败，没有吞错或重试。

macOS arm64 本机安全临时目录实验：同样的文件、可执行权限和软链接，显式参数创建成功，`hdiutil verify` 通过，`hdiutil imageinfo` 确认为 `Apple_HFS` 且不含 `Apple_APFS`。实验没有手工挂载镜像或操作其他挂载点，临时文件已清理。

`MacDiskImageTests.test_real_packager_creates_verified_hfs_image` 使用临时构造并 ad-hoc 签名的最小应用，执行真实 Python 打包器、`codesign`、`ditto`、`hdiutil`，再检查文件系统与镜像校验。该夹具不复制或替换正式 BeefTV 应用。非 macOS 环境跳过此原生用例。

该修改是否消除 Intel runner 的 `Resource busy` 必须由修改后的 Intel 安装器检查确认。本机创建成功不能替代 Intel CI；若仍失败，使用新增 verbose 日志判断发生在格式化、拷贝还是卸载阶段，再选下一项检查，不能继续无差别重跑。
