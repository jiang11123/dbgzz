# 模型服务请求协议包

模型目录接口与请求协议目录是两条独立路径。读取到模型不代表本机已经加载该模型的请求协议。

BeefTV 后端从 `CANVAS_OFFICIAL_PLUGIN_DIR` 指定目录加载 `.beeftv-plugin` ZIP 包，不扫描协议源码子目录。Windows 构建由 `scripts/build-beeftv-plugins.ps1` 将 `manifest.json` 和声明的文档、资源、运行文件按允许的包内路径打包；`build:beeftv` 先生成 `build/beeftv-plugins`，安装包从此目录携带协议包。

开发启动前也需生成该目录。正式安装的协议包位于 `resources/beeftv-plugins`。启动后通过 `/api/plugins/catalog?scope=user.custom-channel` 检查模型协议目录，不应仅用模型列表读取成功作为协议可用依据。

模型服务保存时仍校验每个选中模型的请求协议。缺失协议或保存失败时，错误显示在弹窗底部固定操作区上方，避免提示被长列表滚动隐藏。读取模型目录和保存配置不会自动发起收费的生成测试。
