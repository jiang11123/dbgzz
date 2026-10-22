# 产品 Logo 资源

- `brand-avatar.png`：基于用户提供的奶蛙老师人物图，通过内置 imagegen 编辑得到的方形头像源文件。
- `icon.png`：Windows 窗口运行时和文档使用的 256px PNG。
- `icon.ico`：含 16、24、32、48、64、128、256px 的 Windows 图标。
- `../src/renderer/assets/logo.png`：512px 界面与 favicon 图像。

执行 `npm run build:icons` 可由头像源文件重新转换 PNG/ICO（需要已经安装项目依赖）。正常构建使用已提交资源，不需要重新生成。

图像编辑提示词：裁取原图人物完整头部及肩部，保留黄色人物、绿色眼睛、朝向、西装和奶油色领口，白色背景，不添加文字，适合小尺寸应用头像。使用内置 imagegen，无 CLI/API 回退。
