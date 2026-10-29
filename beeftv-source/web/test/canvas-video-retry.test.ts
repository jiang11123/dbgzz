import { expect, test, mock } from "bun:test";
import { retryStoredCanvasVideo } from "../src/services/canvas-video-retry";
import type { GenerationTask } from "../src/services/api/task-center";

test("video retry reuses the persisted task without reading changed canvas inputs", async () => {
    const task = { id: "original", type: "canvas_video", status: "failed", prompt: "original compiled prompt" } as GenerationTask;
    const queryGenerationTask = mock(async () => task);
    const retryGenerationTask = mock(async (_id: string, _options?: unknown) => ({ ...task, status: "queued" as const }));
    const waitForGenerationTask = mock(async () => ({ ...task, status: "succeeded" as const }));
    const result = await retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, { queryGenerationTask, retryGenerationTask, waitForGenerationTask });
    expect(retryGenerationTask.mock.calls[0]?.[0]).toBe("original");
    expect(retryGenerationTask.mock.calls[0]?.[1]).toHaveProperty("expectedScope");
    expect(result.prompt).toBe(task.prompt);
    expect(waitForGenerationTask.mock.calls[0]?.[0]).toBe(task.id);
});

test("cancelled observation cannot start a paid retry", async () => {
    const controller = new AbortController();
    const task = { id: "original", type: "canvas_video", status: "failed" } as GenerationTask;
    const retryGenerationTask = mock(async () => task);
    await expect(retryStoredCanvasVideo(task.id, controller.signal, () => {}, {
        queryGenerationTask: async () => { controller.abort(); return task; },
        retryGenerationTask,
        waitForGenerationTask: async () => task,
    })).rejects.toThrow();
    expect(retryGenerationTask).not.toHaveBeenCalled();
});

test("accepted or completed original videos are recovered instead of resubmitted", async () => {
    for (const status of ["running", "succeeded"] as const) {
        const task = { id: "original", type: "canvas_video", status } as GenerationTask;
        const retryGenerationTask = mock(async () => task);
        await retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, {
            queryGenerationTask: async () => task, retryGenerationTask, waitForGenerationTask: async () => task,
        });
        expect(retryGenerationTask).not.toHaveBeenCalled();
    }
});
