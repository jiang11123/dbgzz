# 产品 Logo 资源

- `brand-avatar.png`：用户提供的奶蛙老师原图，保留原始内容。
- `icon.png`：Windows 窗口运行时和文档使用的 256px PNG。
- `icon.ico`：含 16、24、32、48、64、128、256px 的 Windows 图标。
- `../src/renderer/assets/logo.png`：512px 界面与 favicon 图像。

执行 `npm run build:icons` 可由头像源文件重新转换 PNG/ICO（需要已经安装项目依赖）。正常构建使用已提交资源，不需要重新生成。

转换时按原始比例缩放，在白色方形画布中居中，不拉伸、不裁切。画布前端的 `web/public/beef-logo.png`、`assets/app-icon.png` 同步使用 512px 资源；启动占位页使用内嵌 PNG，避免 data URL 页面无法读取本地文件。
