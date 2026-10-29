package app

// 旧内置 Agent 的任务 operation。task_creation / task_worker 用这些标记拒绝
// 历史记录重新进入模型调用；字符串必须与库里已有行保持一致。
const cloudAgentOperation = "cloud_agent"

// 记忆压缩任务的 operation。它不以 cloud_agent 为前缀，但同样属于退场范围。
const cloudAgentMemoryCompactOp = "agent_memory_compact"
