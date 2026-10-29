<p align="center">
  <img src="assets/readme/beeftv-wordmark.svg" width="640" alt="BeefTV — High-performance, lightweight, AI-native video workspace">
</p>

<p align="center"><strong>High-performance · Lightweight · AI Native</strong></p>

<p align="center">
  An AI-native workspace for video creation.<br>
  Connect ideas, models, and media on one freeform canvas.
</p>

<p align="center">
  <a href="https://github.com/glanderness/BeefTV/stargazers"><img src="https://img.shields.io/github/stars/glanderness/BeefTV?style=flat-square&amp;logo=github&amp;label=Stars&amp;labelColor=303030&amp;color=E86C36" alt="BeefTV GitHub stars"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="https://img.shields.io/github/v/release/glanderness/BeefTV?style=flat-square&amp;label=Release&amp;labelColor=303030&amp;color=525252" alt="Latest BeefTV release"></a>
  <a href="QUICKSTART.md#下载与首次打开"><img src="https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-525252?style=flat-square&amp;labelColor=303030" alt="Desktop support for macOS and Windows"></a>
  <a href="QUICKSTART.md"><img src="https://img.shields.io/badge/Workspace-Local--first-525252?style=flat-square&amp;labelColor=303030" alt="Local-first workspace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Source%20Available-525252?style=flat-square&amp;labelColor=303030" alt="Source-available license; see LICENSE for terms"></a>
</p>

<p align="center">
  <a href="https://beeftv.app/"><img src="assets/readme/button-website.svg" width="180" alt="Visit the BeefTV website"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="assets/readme/button-download.svg" width="175" alt="Download BeefTV desktop app"></a>
  <a href="https://beeftv.app/assets/beeftv-wecom-qr.png"><img src="assets/readme/button-community.svg" width="185" alt="Scan to join the BeefTV community"></a>
  <a href="https://x.com/beefnoode"><img src="assets/readme/button-x.svg" width="180" alt="Follow @beefnoode on X"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="#product-demo">Product demo</a> ·
  <a href="docs/content/docs/overview/features.mdx">Feature list</a> ·
  <a href="QUICKSTART.md">Get started</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

## Product demo

https://github.com/user-attachments/assets/94fe6a39-6933-44b3-a9a9-dbc28b2d284c

[Download the product demo video](https://github.com/glanderness/BeefTV/releases/download/v1.5.5/beeftv-demo.mp4)

## Why BeefTV

| High Performance | Lightweight | AI Native |
| --- | --- | --- |
| Optimized for complex creative canvases. Viewport rendering, node loading, media previews, and generation tasks are decoupled to keep projects responsive as they grow. | Designed for low resource use and an easy start. Begin creating in one desktop workspace, with capabilities loaded as needed. | AI is an essential part of the workspace, not an extra button. Let agents take an active role in your AIGC creation workflow. |

## One canvas, a complete creative workflow

- **Generate:** Create text, images, video, and audio from prompts or reference media.
- **Organize:** Connect nodes to build relationships between assets, creative context, and generation steps.
- **Refine:** Crop, annotate, inpaint, split, reference, and combine results.
- **Iterate:** Keep your process and reuse assets, turning a single generation into an evolving workflow.

BeefTV also includes project and personal asset libraries, asynchronous tasks, model providers, and creative tools. See the full [feature list](docs/content/docs/overview/features.mdx).

## How it works

```text
Ideas / reference media
         ↓
AI-native freeform canvas
         ↓
Models + creative tools
         ↓
Text / images / video / audio / storyboards
         ↓
Editable, reusable workflows that you can keep building on
```

## Open by design

- Configure text, image, video, and audio model providers freely, without being tied to a single provider.
- Manage projects, canvases, assets, and tasks in one workspace, with data that can be saved and migrated locally.
- Built for desktop with React, Go, and Wails, with extensible model protocols and workspace capabilities.

## Get started

Download the desktop app and read the first-launch instructions for macOS in [Quick Start](QUICKSTART.md#下载与首次打开).

```bash
git clone https://github.com/glanderness/BeefTV.git
cd BeefTV
./scripts/build-beeftv-release.sh
```

For system requirements, Windows builds, and local development, see [`QUICKSTART.md`](QUICKSTART.md) and the [desktop release guide](docs/desktop-release.md). After launching, add a model provider to start creating.

## Contributing and license

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and testing requirements.

The repository uses licenses with different scopes. Original content added under the new license, starting with the commit that first introduced it and subject to its terms, is covered by the [`BeefTV Source Available License 1.0`](LICENSE). Historical content released under MIT remains under the MIT terms retained in the same file. Upstream and third-party materials keep their respective licenses.

The new license permits self-hosting, internal customization, and creating and selling works with BeefTV. Written authorization is required for commercial resale, rebranding and resale, paid deployment or custom delivery of covered software, and providing hosted features to third parties, whether free or paid. Independent tutorials, training, and general technical consulting may be paid services, but must not be used to deliver the software system indirectly. Contact us about authorization at [lucas@bf-labs.cn](mailto:lucas@bf-labs.cn).

The new restrictions do not apply retroactively to historical MIT content or override independently licensed third-party materials. This is a source-available license; the entire repository should not be treated as standard MIT or as an open source project under the OSI definition. See the [license guide](docs/content/docs/overview/licensing.mdx) for covered scenarios and boundaries, and [`NOTICE`](NOTICE) for upstream sources and third-party attributions.

## ⭐ Star History

<a href="https://www.star-history.com/?repos=glanderness%2FBeefTV&amp;type=date&amp;legend=bottom-right">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;theme=dark&amp;legend=bottom-right" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
    <img alt="BeefTV GitHub star history" src="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
  </picture>
</a>
