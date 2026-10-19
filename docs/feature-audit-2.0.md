# 豆包工作站 · 功能保留判定（2.0 大更新）

盘点：2026-10-14 · 基线 dbgzz 0.1.2 · **执行结果见 [2.0 执行记录](2.0-execution-log.md)**

> 本文是更新**前**的盘点，用于决策哪些保留、哪些删除。实际执行后的状态以执行记录为准。

## 0. 结论

**后端能力比界面完整得多。** 仓库里有大量"引擎还在、方向盘没了"的功能：Video2X 超分引擎、视频库、项目/任务/资产系统、画布桥接 HTTP 服务全部实现完好，但渲染层已无入口。2.0 不应重写，而是把入口补回来 + 把会话层抽出来做网关。

## 1. 实测基线（更新前）

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.main.json` | ✅ exit 0 |
| `tsc --noEmit -p tsconfig.renderer.json` | ✅ exit 0 |
| `node --test dist/main/main/*.test.js` | ✅ 25 passed / 0 failed |
| `npm test` | ❌ package.json 里没有 test 脚本 |
| 源码直跑 `node --test src/**/*.test.ts` | ❌ 失败（CJS 无扩展名导入 + strip-types 不兼容） |

## 2. 功能清单与判定

### A. 核心资产 —— 保留

| # | 功能 | 位置 | 判定 |
|---|---|---|---|
| A1 | 多账号独立 Session 分区 | `account-platform.ts` | ✅ 保留，账号池的物理载体 |
| A2 | 账号表 + 排序 + 备注 + 平台 | `database.ts` | ✅ 保留并扩展 |
| A3 | 账号切换与顶栏 | `main.ts` | ✅ 保留 |
| A4 | 启动预热（错峰拉起所有账号） | `main.ts` | ✅ 保留，即账号池预热 |
| A5 | OAuth 子窗口 + postMessage 关系 | `main.ts` | ✅ 保留，登录态唯一正路 |
| A6 | 账号快捷键 | `shared/account-shortcuts.ts` | ✅ 保留 |
| A7 | 可调高度账号栏/图片栏 | `resizable-bar.tsx` | ✅ 保留 |
| A8 | 图片资产库（SHA256 去重） | `image-assets.ts` | ✅ 保留 |
| A9 | 图片拖拽 + CDP 注入上传 | `main.ts` | ✅ 保留，比 Playwright setInputFiles 更稳 |

### B. 有引擎没入口

| # | 功能 | 判定 |
|---|---|---|
| B1 | Video2X 2K/4K 超分 | 🔴 **按用户要求已整体删除**（见执行记录） |
| B2 | 视频库后端 | ⚠️ 后端保留，UI 仍未补 |
| B3 | 项目 / 任务 / 资产 IPC | ⚠️ 上一代工作流残留，建议用 `gateway_tasks` 替代 |

### C. 有服务没客户

| # | 功能 | 判定 |
|---|---|---|
| C1 | CanvasBridge HTTP 服务（`:3219`） | ✅ 保留为 2.0 网关雏形 |
| C2 | 画布任务状态机（9 态） | ✅ 保留，即网关任务模型 |
| C3 | `pickAvailableAccount()` 硬编码"旺仔" | 🔴 **已整段替换为 AccountPool** |
| C4 | 额度耗尽正则 | ✅ 已抽成 `classifyDispatchFailure()` + 错误码表 |
| C5 | 视频结果下载/回写 | ✅ 保留 |
| C6 | 任务页恢复 | ✅ 保留 |
| C7 | `sharedChatId` 字段 | 🔴 已删除 |

### D. 已彻底删除的功能（文档残留）

| # | 功能 | 判定 |
|---|---|---|
| D1 | 共享聊天 / 主副账号 / 共同记忆 | 🔴 代码已删，`docs/shared-workspace.md` 已重写为真实功能 |
| D2 | 视频代发 / 模型时长选择 / 视频任务回传 | ✅ 此前已正确移除 |
| D3 | 时长 / 额度列 | ✅ 迁移干净（带自动备份） |

### E. 已清理的杂物

| 对象 | 体积 | 处理 |
|---|---|---|
| `tools/`（video2x 重复副本 + zip） | 950.7 MB | 删除 |
| `release/`（3 个旧安装包 + 缓存 + 产物） | 656.1 MB | 删除 |
| `exports/`（测试截图/视频） | 102.0 MB | 删除 |
| `snake.html`、`start-canvas-bridge.cmd`、4 个空日志 | 11 KB | 删除 |
| `style.css` 中 video-library / upscale / collab 死样式 | — | 删除 |

> 工作区 2.17 GB → 约 460 MB。

### F. 健在且质量不错 —— 保留

| # | 功能 | 位置 |
|---|---|---|
| F1 | 豆包分享链接解析 + 无水印下载 | `doubao-share.ts`（域名白名单、12MB/1GB 上限、流式） |
| F2 | 右键视频 → 无水印原片 | `video-context.ts` |
| F3 | 跨账号发送文字/图片 | `account-send.ts`（草稿保护、忙账号互斥） |
| F4 | 按顺序重新导入聊天图片 | `message-sync-panel.tsx` |
| F5 | 聊天图片 DOM 去重提取 | `attachment-dom.ts`（透明占位图 + 85% 重叠去重） |
| F6 | 输入框/模式/比例控制 | `page-composer.ts` |
| F7 | 下载拦截 + 去重 | `download-tracker.ts` |
| F8 | 数据库迁移与自动备份 | `database.ts`（删列前 VACUUM INTO 备份） |

## 3. 三条最容易踩的坑

1. **别在 `pickAvailableAccount` 上打补丁** —— 已整段替换为 `AccountPool`，硬编码账号名会从第一天起毁掉账号池。
2. **`npm test` 必须先补** —— 已补：`build:main` + `node --test "dist/main/main/**/*.test.js"`。
3. **测试脚本不要依赖 `exports/`** —— 该目录是 gitignore 的产物目录，`check-account-send.cjs` 已改为内联生成 fixture。
