import { expect, test } from "bun:test";
import { AxiosError } from "axios";
import { apiClient, ApiError } from "@/services/api/request";
import { getTranscriptionModels, createTimelineTranscriptionTask } from "@/services/api/timeline-tasks";
import { captureUserScope } from "@/lib/user-scope-guard";
import { isUncertainLocalExecutorSubmit, localExecutorIntentAfterError, nextLocalExecutorClientOperationId } from "@/lib/plugins/builtin/editor/local-executor-session";

test("cloud catalog and admission allow the server catalog budget while preserving scope and signal", async () => {
    const previous = apiClient.defaults.adapter;
    const scope = captureUserScope();
    const controller = new AbortController();
    const requests: Array<{ timeout?: number; data?: unknown }> = [];
    apiClient.defaults.adapter = async config => {
        requests.push(config);
        expect(config.timeout).toBe(35_000);
        expect(config.signal).toBe(controller.signal);
        expect((config as typeof config & { expectedScope: typeof scope }).expectedScope).toEqual(scope);
        return { status: 200, statusText: "OK", headers: {}, config, data: { code: 0, data: config.url?.endsWith("models") ? { models: [{ id: "hy-asr-3.0-preview", supportedEndpointTypes: ["audio.transcriptions"] }] } : { id: "task", status: "queued" } } };
    };
    try {
        expect(await getTranscriptionModels({ expectedScope: scope, signal: controller.signal })).toHaveLength(1);
        expect((await createTimelineTranscriptionTask({ resourceId: "resource", model: "hy-asr-3.0-preview", clientOperationId: "stable-operation" }, { expectedScope: scope, signal: controller.signal })).id).toBe("task");
        expect(requests).toHaveLength(2);
        expect(JSON.parse(String(requests[1].data)).clientOperationId).toBe("stable-operation");
    } finally { apiClient.defaults.adapter = previous; }
});

test("timeout is readable Chinese, never auto-retries and preserves uncertain submit identity", async () => {
    const previous = apiClient.defaults.adapter;
    let calls = 0;
    apiClient.defaults.adapter = async config => { calls++; throw new AxiosError("timeout of 35000ms exceeded", "ECONNABORTED", config); };
    try {
        await expect(getTranscriptionModels()).rejects.toThrow("读取转写模型超时");
        expect(calls).toBe(1);
        let failure: unknown;
        try { await createTimelineTranscriptionTask({ resourceId: "resource", model: "hy-asr-3.0-preview", clientOperationId: "stable-operation" }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as Error).message).toContain("任务可能已创建");
        expect(isUncertainLocalExecutorSubmit(failure)).toBe(true);
        const intent = localExecutorIntentAfterError({ clientOperationId: "stable-operation", frozenInputKey: "same-input" }, failure);
        expect(nextLocalExecutorClientOperationId(intent, "same-input")).toBe("stable-operation");
        expect(calls).toBe(2);
    } finally { apiClient.defaults.adapter = previous; }
});
