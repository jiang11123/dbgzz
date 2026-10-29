import { apiClient } from "../src/services/api/request";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { canRecoverUpscaleNode, hasPendingUpscaleTask, isAIUpscaleTask, upscaleObservationFailureMetadata, UPSCALE_OBSERVATION_TIMEOUT_MS } from "../src/lib/canvas/canvas-ai-upscale-task";
import { createModelChannel, modelOptionsFromChannels } from "../src/stores/use-config-store";
import { describe, expect, test } from "bun:test";
import { createUpscaleTask, estimateUpscale, recoverUpscaleTask, UPSCALE_CREATE_TIMEOUT_MS, UPSCALE_ESTIMATE_TIMEOUT_MS, UPSCALE_RECOVER_TIMEOUT_MS, validUpscaleScale } from "../src/services/api/media-upscale";
import { parseBackendGenerationResult } from "../src/services/api/generation-task";
import { generationTaskMode } from "../src/lib/canvas/canvas-generation-task-sync";
import type { GenerationTask } from "../src/services/api/task-center";

const task = (patch: Partial<GenerationTask>): GenerationTask => ({ id: "topaz", type: "canvas_image", model: "topaz-standard-v2", status: "succeeded", prompt: "", attempts: 1, createdAt: "", updatedAt: "", ...patch });
describe("Topaz upscale contract", () => {
    test("recovery recognizes the four official models with matching task types", () => {
        for (const model of ["topaz-standard-v2", "topaz-wonder-3.5"]) expect(isAIUpscaleTask(task({ model }))).toBe(true);
        for (const model of ["topaz-proteus", "topaz-starlight-fast-2"]) expect(isAIUpscaleTask(task({ type: "canvas_video", model }))).toBe(true);
        expect(isAIUpscaleTask(task({ model: "topaz-proteus" }))).toBe(false);
        expect(isAIUpscaleTask(task({ model: "gpt-image-2" }))).toBe(false);
    });
    test("failed upscale placeholder exposes recovery even without source media", () => {
        const node: CanvasNodeData = { id: "result", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { taskId: "original", taskStatus: "failed", status: "error", workflowOperation: { id: "image.ai-upscale", version: 1, config: {}, inputs: [] } } };
        expect(canRecoverUpscaleNode(node)).toBe(true);
        expect(canRecoverUpscaleNode({ ...node, metadata: { ...node.metadata, taskId: undefined } })).toBe(false);
        expect(canRecoverUpscaleNode({ ...node, metadata: { ...node.metadata, workflowOperation: undefined } })).toBe(false);
    });
    test("recovery calls only the original task recovery endpoint", async () => {
        const originalRequest = apiClient.request;
        const requests: Array<{ method?: string; url?: string; data?: unknown; timeout?: number }> = [];
        apiClient.request = (async request => {
            requests.push({ method: request.method, url: request.url, data: request.data, timeout: request.timeout });
            return { status: 200, data: { code: 0, data: task({ id: "original", status: "running" }) } };
        }) as typeof apiClient.request;
        try {
            expect((await recoverUpscaleTask("original")).id).toBe("original");
            expect(requests).toEqual([{ method: "post", url: "/media-upscale/tasks/original/recover", data: {}, timeout: UPSCALE_RECOVER_TIMEOUT_MS }]);
        } finally { apiClient.request = originalRequest; }
    });
    test("estimate and create override the 4s default client timeout for media preupload and probe", async () => {
        const originalRequest = apiClient.request;
        const timeouts: Array<{ url?: string; timeout?: number }> = [];
        const originalWindow = globalThis.window;
        if (typeof globalThis.window === "undefined") {
            (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
        }
        apiClient.request = (async request => {
            timeouts.push({ url: request.url, timeout: request.timeout });
            if (request.url === "/media-upscale/estimate") {
                return { status: 200, data: { code: 0, data: { mediaType: "video", source: { width: 1280, height: 720, durationMs: 115752 }, output: { width: 2560, height: 1440, durationMs: 115752 }, reservation: 70, currency: "CNY", generationSubmitted: false, cloudProcessing: true } } };
            }
            return { status: 200, data: { code: 0, data: task({ id: "created", type: "canvas_video", model: "topaz-proteus", status: "queued" }) } };
        }) as typeof apiClient.request;
        try {
            const quote = await estimateUpscale({ resourceId: "res-1", channelId: "beefapi", mode: "precision", model: "topaz-proteus", scale: 2 });
            expect(quote.reservation).toBe(70);
            const created = await createUpscaleTask({ resourceId: "res-1", channelId: "beefapi", mode: "precision", model: "topaz-proteus", scale: 2, clientOperationId: "op-1", projectId: "proj-1", nodeId: "node-1" });
            expect(created.id).toBe("created");
            expect(timeouts).toEqual([
                { url: "/media-upscale/estimate", timeout: UPSCALE_ESTIMATE_TIMEOUT_MS },
                { url: "/media-upscale/tasks", timeout: UPSCALE_CREATE_TIMEOUT_MS },
            ]);
            expect(UPSCALE_ESTIMATE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
            expect(UPSCALE_CREATE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
        } finally {
            apiClient.request = originalRequest;
            if (typeof originalWindow === "undefined") {
                delete (globalThis as unknown as { window?: EventTarget }).window;
            }
        }
    });
    test("observer timeout and network errors cannot authorize another paid task", () => {
        expect(UPSCALE_OBSERVATION_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1000);
        for (const status of ["queued", "running"] as const) {
            for (const reason of ["任务执行超时", "Network Error"]) {
                const metadata = upscaleObservationFailureMetadata({ id: "topaz", status }, reason);
                expect(metadata.status).toBe("loading");
                expect(metadata.taskStatus).toBe(status);
                expect(hasPendingUpscaleTask(metadata)).toBe(true);
                expect(hasPendingUpscaleTask({ ...metadata, status: "error" })).toBe(true);
            }
        }
        expect(hasPendingUpscaleTask({ taskId: "topaz", status: "error" })).toBe(true);
        expect(hasPendingUpscaleTask({ taskClientOperationId: "unknown", status: "error", generationSubmissionState: "unknown" })).toBe(true);
    });
    test("failed or cancelled tasks still require checking the original paid task", () => {
        for (const status of ["failed", "cancelled"] as const) {
            const metadata = upscaleObservationFailureMetadata({ id: "topaz", status }, "终态");
            expect(metadata.status).toBe("error");
            expect(hasPendingUpscaleTask(metadata)).toBe(true);
            expect(metadata.errorDetails).toContain("任务详情");
        }
        expect(hasPendingUpscaleTask({ taskClientOperationId: "not-submitted", taskStatus: "failed", generationSubmissionState: "rejected" })).toBe(false);
        expect(hasPendingUpscaleTask({ taskId: "paid-task", taskClientOperationId: "submitted", taskStatus: "failed", generationSubmissionState: "rejected" })).toBe(true);
        expect(hasPendingUpscaleTask({ taskClientOperationId: "unknown", taskStatus: "failed", generationSubmissionState: "unknown" })).toBe(true);
        const succeeded = upscaleObservationFailureMetadata({ id: "topaz", status: "succeeded" }, "落图失败");
        expect(hasPendingUpscaleTask(succeeded)).toBe(true);
        expect(hasPendingUpscaleTask({ ...succeeded, content: "resource-result" })).toBe(false);
    });
    test("processing models stay in settings but leave normal generation selectors", () => {
        const endpoints = ["topaz/upscale/image/precision", "topaz/upscale/image/generative", "topaz/upscale/image/transparent", "topaz/upscale/video/precision", "topaz/upscale/video/generative", "/topaz/upscale/image/precision", "topaz-standard-v2", "topaz-wonder-3.5", "topaz-proteus", "topaz-starlight-fast-2"];
        const channel = createModelChannel({ id: "fal", models: [...endpoints, "fal-ai/flux/dev"] });
        expect(modelOptionsFromChannels([channel])).toEqual(["fal::fal-ai/flux/dev"]);
        expect(channel.models).toEqual([...endpoints, "fal-ai/flux/dev"]);
    });
    test("official upscale uses integer scale bounds", () => {
        for (const value of [1, 2, 3, 4]) expect(validUpscaleScale(value)).toBe(true);
        for (const value of [0, 1.5, 4.1, NaN, Infinity]) expect(validUpscaleScale(value)).toBe(false);
        expect(validUpscaleScale(2, 4)).toBe(false);
        expect(validUpscaleScale(4, 4)).toBe(true);
    });
    test("owned image result is recoverable without remote URL", () => {
        const result = parseBackendGenerationResult(task({ resultJson: JSON.stringify({ mode: "image", images: [{ storageKey: "resource:image1", width: 200, height: 100 }] }) }));
        expect(result.images?.[0].storageKey).toContain("image1");
        expect(result.images?.[0].width).toBe(200);
    });
    test("video recovery does not default to image", () => {
        expect(generationTaskMode(task({ type: "canvas_video", model: "topaz-proteus", inputJson: JSON.stringify({ mode: "video" }) }))).toBe("video");
        const result = parseBackendGenerationResult(task({ type: "canvas_video", model: "topaz-proteus", resultJson: JSON.stringify({ mode: "video", video: { storageKey: "resource:video1", width: 200, height: 100, durationMs: 1000 } }) }));
        expect(result.video?.durationMs).toBe(1000);
    });
});
