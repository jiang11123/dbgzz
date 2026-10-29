import { expect, test } from "bun:test";

import { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "@/services/api/task-center";

test("hydrates a completed text task from the generation result before consuming it", async () => {
    const terminalTask = {
        id: "task-text-1",
        type: "canvas_text",
        status: "succeeded",
        prompt: "你好",
    } as GenerationTask;
    let consumedTask: GenerationTask | undefined;

    await runCanvasGenerationTaskToConsumer(
        {
            projectId: "canvas-1",
            nodeId: "text-node-1",
            mode: "text",
            prompt: "你好",
            config: {} as never,
        },
        {
            prepareTarget: async () => undefined,
            bindTask: () => undefined,
            consumeTask: async (task) => {
                consumedTask = task;
            },
            runTask: async (options) => {
                options.onTaskCreated?.(terminalTask);
                return { mode: "text", text: "你好！有什么可以帮你？" };
            },
        },
    );

    expect(JSON.parse(consumedTask?.resultJson || "{}").text).toBe("你好！有什么可以帮你？");
});

test("preserves existing text task result fields while hydrating the final text", async () => {
    const terminalTask = {
        id: "task-text-2",
        type: "canvas_text",
        status: "succeeded",
        prompt: "你好",
        resultJson: JSON.stringify({ mode: "text", reasoning: "brief reasoning" }),
    } as GenerationTask;
    let consumedTask: GenerationTask | undefined;

    await runCanvasGenerationTaskToConsumer(
        { projectId: "canvas-1", nodeId: "text-node-2", mode: "text", prompt: "你好", config: {} as never },
        {
            prepareTarget: async () => undefined,
            bindTask: () => undefined,
            consumeTask: async (task) => {
                consumedTask = task;
            },
            runTask: async (options) => {
                options.onTaskCreated?.(terminalTask);
                return { mode: "text", text: "最终正文", reasoning: "brief reasoning" };
            },
        },
    );

    expect(JSON.parse(consumedTask?.resultJson || "{}")).toEqual({ mode: "text", reasoning: "brief reasoning", text: "最终正文" });
});
