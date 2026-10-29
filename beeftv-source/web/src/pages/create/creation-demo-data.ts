import type { CreationConversation } from "./creation-types";

/** 固定的演示会话：只用于展示 Agent 对话流，不会写入本地会话或调用生成接口。 */
export function createDemoConversation(): CreationConversation {
    const base = "2026-09-19T10:00:00.000Z";
    return {
        id: "demo-conversation",
        title: "模拟视频创作流程",
        updatedAt: base,
        messages: [
            {
                id: "demo-user-plan",
                role: "user",
                content: "我想做一段 6 秒的电影感视频：夜晚的香港街头，镜头缓慢推进，霓虹灯倒映在雨水中。",
                createdAt: base,
                mode: "text",
                status: "done",
            },
            {
                id: "demo-assistant-plan",
                role: "assistant",
                content: "我会先把想法拆成一个可执行的镜头：雨夜街景建立氛围，镜头缓慢向前推进，最后落到霓虹倒影。接下来可以直接生成视频。",
                createdAt: "2026-09-19T10:00:05.000Z",
                mode: "text",
                status: "done",
            },
            {
                id: "demo-user-generate",
                role: "user",
                content: "按这个方案生成视频，画幅 16:9，时长 6 秒。",
                createdAt: "2026-09-19T10:00:12.000Z",
                mode: "video",
                status: "done",
                settings: { ratio: "16:9", seconds: "6", quality: "auto", videoQuality: "720", count: "1" },
            },
            {
                id: "demo-assistant-generating",
                role: "assistant",
                content: "",
                createdAt: "2026-09-19T10:00:14.000Z",
                mode: "video",
                status: "pending",
                generationStage: "rendering",
                settings: { ratio: "16:9", seconds: "6", quality: "auto", videoQuality: "720", count: "1" },
            },
        ],
    };
}
