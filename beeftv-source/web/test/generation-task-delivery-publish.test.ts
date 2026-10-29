import { afterAll, expect, test } from "bun:test";

import { apiClient } from "@/services/api/request";
import { waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { useGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";

// task-center's poll delay reads window.setTimeout; bun's test runtime has no window.
const addedWindow = typeof window === "undefined";
if (addedWindow) Object.assign(globalThis, { window: globalThis });
afterAll(() => {
    if (addedWindow) delete (globalThis as { window?: unknown }).window;
});

const taskId = "task-delivery-publish";

function queue(responses: Array<Partial<GenerationTask>>, seen: Array<unknown>) {
    const previousAdapter = apiClient.defaults.adapter;
    let call = 0;
    apiClient.defaults.adapter = async (config) => {
        seen.push(useGenerationDeliveryProgress.getState().byTask[taskId]);
        const data = { id: taskId, ...responses[Math.min(call, responses.length - 1)] };
        call += 1;
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
    };
    return () => { apiClient.defaults.adapter = previousAdapter; };
}

const fetching = (downloadedBytes: number) => ({
    status: "running" as const,
    stage: "正在取回生成结果",
    delivery: { outputs: [{ outputIndex: 0, downloadedBytes, totalBytes: 100, bytesPerSecond: 5, state: "downloading" as const }] },
});

test("waitForGenerationTask publishes live delivery while running and clears it when the task settles", async () => {
    const seen: Array<unknown> = [];
    const restore = queue([fetching(40), { status: "running", stage: "正在取回生成结果" }, { status: "succeeded" }], seen);
    try {
        await waitForGenerationTask(taskId, { intervalMs: 1 });
    } finally {
        restore();
    }
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatchObject({ downloadedBytes: 40, totalBytes: 100, state: "downloading" });
    expect(seen[2]).toBeUndefined();
    expect(useGenerationDeliveryProgress.getState().byTask[taskId]).toBeUndefined();
});

test("a waiter clears its own delivery when the task fails", async () => {
    const seen: Array<unknown> = [];
    const restore = queue([fetching(60), { status: "failed", error: "上游失败" }], seen);
    try {
        await expect(waitForGenerationTask(taskId, { intervalMs: 1 })).rejects.toThrow();
    } finally {
        restore();
    }
    expect(seen[1]).toMatchObject({ downloadedBytes: 60 });
    expect(useGenerationDeliveryProgress.getState().byTask[taskId]).toBeUndefined();
});

test("result retrieval polls every 500ms, while generation keeps its normal interval", async () => {
    const seen: Array<unknown> = [];
    const restore = queue([{ status: "running", stage: "生成中" }, { status: "running", stage: "正在取回生成结果" }, fetching(60), { status: "succeeded" }], seen);
    const originalTimer = window.setTimeout;
    const delays: number[] = [];
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        delays.push(delay || 0);
        return originalTimer(callback, 0, ...args);
    }) as typeof window.setTimeout;
    try {
        await waitForGenerationTask(taskId);
    } finally {
        window.setTimeout = originalTimer;
        restore();
    }
    expect(delays).toEqual([2000, 500, 500]);
});
