<p align="center">
  <img src="assets/readme/beeftv-wordmark.svg" width="640" alt="BeefTV — High-performance, lightweight, AI-native video workspace">
</p>

<p align="center"><strong>High-performance · Lightweight · AI Native</strong></p>

<p align="center">
  面向 AI 时代的视频创作工作台。<br>
  在一个自由画布中连接创意、模型与素材。
</p>

<p align="center">
  <a href="https://github.com/glanderness/BeefTV/stargazers"><img src="https://img.shields.io/github/stars/glanderness/BeefTV?style=flat-square&amp;logo=github&amp;label=Stars&amp;labelColor=303030&amp;color=E86C36" alt="BeefTV GitHub Stars"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="https://img.shields.io/github/v/release/glanderness/BeefTV?style=flat-square&amp;label=Release&amp;labelColor=303030&amp;color=525252" alt="BeefTV 最新版本"></a>
  <a href="QUICKSTART.md#下载与首次打开"><img src="https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-525252?style=flat-square&amp;labelColor=303030" alt="桌面版支持 macOS 和 Windows"></a>
  <a href="QUICKSTART.md"><img src="https://img.shields.io/badge/Workspace-Local--first-525252?style=flat-square&amp;labelColor=303030" alt="本地优先工作区"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Source%20Available-525252?style=flat-square&amp;labelColor=303030" alt="源码可用，许可范围见 LICENSE"></a>
</p>

<p align="center">
  <a href="https://beeftv.app/"><img src="assets/readme/button-website.svg" width="180" alt="访问 BeefTV 官网"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="assets/readme/button-download.svg" width="175" alt="下载 BeefTV 桌面版"></a>
  <a href="https://beeftv.app/assets/beeftv-wecom-qr.png"><img src="assets/readme/button-community.svg" width="185" alt="扫码加入 BeefTV 社群"></a>
  <a href="https://x.com/beefnoode"><img src="assets/readme/button-x.svg" width="180" alt="在 X 关注 @beefnoode"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#产品演示">产品演示</a> ·
  <a href="docs/content/docs/overview/features.mdx">功能清单</a> ·
  <a href="QUICKSTART.md">开始使用</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

## 产品演示

https://github.com/user-attachments/assets/94fe6a39-6933-44b3-a9a9-dbc28b2d284c

[下载产品演示视频](https://github.com/glanderness/BeefTV/releases/download/v1.5.5/beeftv-demo.mp4)

## Why BeefTV

| High Performance | Lightweight | AI Native |
| --- | --- | --- |
| 面向复杂创作画布优化。视口渲染、节点加载、媒体预览与生成任务彼此解耦，让项目增长时仍能保持顺畅操作。 | 以低资源占用和低使用门槛为目标。一个桌面工作区即可开始创作，能力按需加载，追求轻量化 | AI 不是附加按钮，而是工作台中不可或缺的一部分。让Agent真正参与并且主导你的AIGC创作流程。 |

## 一个画布，完整创作链路

- **生成**：从提示词或参考素材生成文字、图片、视频与音频。
- **组织**：用节点和连线建立素材关系、创作上下文与生成流程。
- **加工**：继续裁切、标注、局部重绘、拆分、引用和组合结果。
- **迭代**：保留过程、复用素材，让一次生成变成可持续演进的工作流。

BeefTV 同时提供项目库、个人资产库、异步任务、模型渠道与创作工具。完整范围见[功能清单](docs/content/docs/overview/features.mdx)。

## 工作方式

```text
想法 / 参考素材
       ↓
AI Native 自由画布
       ↓
模型 + 创作工具
       ↓
文字 / 图片 / 视频 / 音频 / 分镜
       ↓
可编辑、可复用、可继续生成的工作流
```

## Open by design

- 可以自由配置文本、图片、视频与音频模型渠道，不绑定单一 Provider。
- 项目、画布、素材与任务由统一工作区管理，数据可以本地保存和迁移。
- 桌面端基于 React、Go 与 Wails，模型协议和工作台能力可继续自定义或者扩展。

## 开始使用

下载桌面版及 Mac 首次打开说明见 [快速开始](QUICKSTART.md#下载与首次打开)。

```bash
git clone https://github.com/glanderness/BeefTV.git
cd BeefTV
./scripts/build-beeftv-release.sh
```

详细环境要求、Windows 构建与本地开发方式见 [`QUICKSTART.md`](QUICKSTART.md) 和[桌面发布文档](docs/desktop-release.md)。首次启动后，添加自己的模型渠道即可开始创作。

## 贡献与许可

欢迎提交 Issue 和 Pull Request。开发流程与测试要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

仓库采用分范围许可：自首次引入新许可的提交起，符合授权条件的新增原创内容适用 [`BeefTV Source Available License 1.0`](LICENSE)；已按 MIT 发布的历史内容继续适用同文件保留的 MIT 条款，上游和第三方材料保留各自许可。

新许可允许自部署、内部二开及使用 BeefTV 制作并销售作品；对其覆盖的软件进行商业转售、套壳销售、收费部署或定制交付，以及免费或收费向第三方提供托管功能，均需事先书面授权。独立教程、培训和一般技术咨询可收费，不能借此变相交付软件系统。授权联系：[lucas@bf-labs.cn](mailto:lucas@bf-labs.cn)。

新限制不追溯适用于历史 MIT 内容，也不覆盖第三方独立许可的材料。这是一份源码可用许可，不能将整个仓库视为标准 MIT 或 OSI 定义的开源项目。具体场景及覆盖边界见[许可说明](docs/content/docs/overview/licensing.mdx)，上游来源与第三方归属见 [`NOTICE`](NOTICE)。

## ⭐ Star History

<a href="https://www.star-history.com/?repos=glanderness%2FBeefTV&amp;type=date&amp;legend=bottom-right">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;theme=dark&amp;legend=bottom-right" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
    <img alt="BeefTV GitHub Star History" src="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
  </picture>
</a>
