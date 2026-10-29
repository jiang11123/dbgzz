package generation

// 本包是画布生成域：付费编排、声明式协议执行、text/image/video/audio 上游调用与任务恢复/取消。
// Execute 拥有提示词/能力/水合/工作流恢复/占位解析的实际顺序。跨域工作通过 Runtime 上的
// 窄端口进入（Prompt/Config/Style 以及既有 Resources/Limits/Receipts/Images/Workflow/Probe）。
// 组合根在 internal/bootstrap；本包不得 import internal/app。
