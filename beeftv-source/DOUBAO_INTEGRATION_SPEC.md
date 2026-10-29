# BeefTV - 豆包能力深度扩展集成规范

> 本文档由主工作站 `D:\doubao\doubaogzt\DOUBAO_3.0_SPEC.md` 同步生成。

## 核心原则
1. **主框架就是原生 BeefTV**：保留 100% 原生 UI、无限画布、3D 导演台、时间线、资产库与 Beef Agent。
2. **原生第三方 API 逻辑完全不受影响**：设置中的 OpenAI、Claude、Gemini、可灵、MiniMax、ComfyUI 等渠道按原样调用。
3. **底层工作站隐身支撑**：工作站作为本地后台服务（`127.0.0.1:8788`），提供豆包账号会话池、免密网关与视频生成调度。
4. **豆包专属扩展组件**：
   - 画布专属【豆包账号节点】（`doubao-account`），卡片上可下拉自由切换账号；
   - Beef Agent 侧边栏支持选择指定豆包账号对话；
   - 界面内置快速查看账号状态与扫码添加入池。

详细架构设计与字段契约请参阅主项目规范：`D:\doubao\doubaogzt\DOUBAO_3.0_SPEC.md`。
