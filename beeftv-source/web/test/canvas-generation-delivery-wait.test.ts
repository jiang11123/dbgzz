import { beforeEach, describe, expect, test } from "bun:test";

import { bindBackendCanvasGenerationResult, CanvasGenerationDurableAckError, CanvasGenerationMaterializationError } from "@/services/canvas-generation-consumer";
import { ApiError } from "@/services/api/request";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

function captured(userScope: string, epoch: number) {
    return { userScope, epoch };
}

function canvasNode(id: string, metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: "镜头", position: { x: 1, y: 1 }, width: 320, height: 220, metadata };
}

function canvasProject(id: string, nodes: CanvasNodeData[], revision = 4): CanvasProject {
    return {
        id,
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

function mediaTask(overrides: Partial<GenerationTask> = {}): GenerationTask {
    return {
        id: "task-1",
        type: "canvas_image",
        status: "succeeded",
        prompt: "猫",
        attempts: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

function bindResponse(operationId: string, project: CanvasProject, nodeId: string) {
    return {
        op: "canvas.task.bind",
        opId: operationId,
        replayed: false,
        revision: project.revision,
        result: {
            applied: true,
            canvasId: project.id,
            nodeId,
            taskId: "task-1",
            bindingStatus: "bound" as const,
            content: "/api/resources/res-1/file",
            storageKey: "resource:res-1",
            assetId: "generation_abc",
            revision: project.revision,
            canvas: project,
            node: project.nodes.find((item) => item.id === nodeId),
        },
    };
}

// Mirrors use-canvas-generation.applyGenerationTaskResult's wrapping so the test
// observes the same error code the user sees.
async function applyLikeCaller(input: Parameters<typeof bindBackendCanvasGenerationResult>[0]) {
    try {
        await bindBackendCanvasGenerationResult(input);
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw error instanceof CanvasGenerationDurableAckError ? error : new CanvasGenerationDurableAckError(error);
    }
}

describe("bindBackendCanvasGenerationResult waits for delivery", () => {
    beforeEach(() => {
        useCanvasStore.setState({ projects: [] });
    });

    test("waits for materialized output instead of surfacing a canvas conflict", async () => {
        const loading = canvasNode("node-1", { taskId: "task-1", status: "loading" });
        const project = canvasProject("canvas-1", [{ ...loading, metadata: { ...loading.metadata, status: "success", content: "/api/resources/res-1/file" } }], 4);
        useCanvasStore.setState({ projects: [canvasProject("canvas-1", [loading], 3)] });
        const nodesRef = { current: [loading] };
        const identity = captured("user-a", 1);

        const pendingTask = mediaTask({ outputs: [{ outputIndex: 0, mediaType: "image" }] });
        const deliveredTask = mediaTask({ outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "generation_abc" }] });

        let refreshes = 0;
        let bindCalls = 0;
        const phases: string[] = [];
        let caught: unknown;
        try {
            await applyLikeCaller({
                canvasId: "canvas-1",
                nodeId: "node-1",
                task: pendingTask,
                onPhaseChange: phase => phases.push(phase),
                isCurrent: () => true,
                nodesRef,
                setNodes: (value) => {
                    nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
                },
                runtime: {
                    hydrateOutputs: async () => { expect(phases).toEqual(["fetching", "saving"]); },
                    persistDocument: async () => undefined,
                    bindOutput: async (input) => {
                        bindCalls += 1;
                        return bindResponse(input.operationId, project, "node-1");
                    },
                    adoptConfirmedProjection: async (adopted) => adopted,
                    captureScope: () => identity,
                    liveScope: () => identity,
                    refreshTask: async () => {
                        expect(phases).toEqual(["fetching"]);
                        refreshes += 1;
                        return deliveredTask;
                    },
                    sleep: async () => undefined,
                    now: () => Date.now(),
                },
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeUndefined();
        expect(refreshes).toBeGreaterThanOrEqual(1);
        expect(bindCalls).toBe(1);
        expect(nodesRef.current[0]?.metadata?.status).toBe("success");
    });

    test("retries bind after output_not_ready once the output materializes", async () => {
        const loading = canvasNode("node-1", { taskId: "task-1", status: "loading" });
        const project = canvasProject("canvas-1", [{ ...loading, metadata: { ...loading.metadata, status: "success", content: "/api/resources/res-1/file" } }], 4);
        useCanvasStore.setState({ projects: [canvasProject("canvas-1", [loading], 3)] });
        const nodesRef = { current: [loading] };
        const identity = captured("user-a", 1);

        const deliveredTask = mediaTask({ outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "generation_abc" }] });
        let refreshes = 0;
        let bindCalls = 0;
        const phases: string[] = [];

        await applyLikeCaller({
            canvasId: "canvas-1",
            nodeId: "node-1",
            task: deliveredTask,
            onPhaseChange: phase => phases.push(phase),
            isCurrent: () => true,
            nodesRef,
            setNodes: (value) => {
                nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
            },
            runtime: {
                hydrateOutputs: async () => undefined,
                persistDocument: async () => undefined,
                bindOutput: async (input) => {
                    bindCalls += 1;
                    if (bindCalls === 1) throw new ApiError("任务产物尚未交付，不能绑定到画布", { status: 412, reason: "output_not_ready" });
                    return bindResponse(input.operationId, project, "node-1");
                },
                adoptConfirmedProjection: async (adopted) => adopted,
                captureScope: () => identity,
                liveScope: () => identity,
                refreshTask: async () => {
                    refreshes += 1;
                    return deliveredTask;
                },
                sleep: async () => undefined,
                now: () => Date.now(),
            },
        });

        expect(refreshes).toBeGreaterThanOrEqual(1);
        expect(bindCalls).toBe(2);
        expect(phases).toEqual(["saving", "fetching", "saving"]);
    });

    test.each(["output_not_ready", "resource_not_ready"])("stops repeated %s rejections even when the output claims a materialized asset", async (reason) => {
        const identity = captured("user-a", 1);
        const deliveredTask = mediaTask({ outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "missing-asset" }] });
        let elapsed = 0;
        let bindCalls = 0;
        const operationIds = new Set<string>();
        const published: unknown[] = [];
        const binding = bindBackendCanvasGenerationResult({
            canvasId: "canvas-1", nodeId: "node-1", task: deliveredTask, isCurrent: () => true,
            nodesRef: { current: [] }, setNodes: () => { throw new Error("failed binding must not change the canvas"); },
            runtime: {
                captureScope: () => identity, liveScope: () => identity,
                hydrateOutputs: async () => undefined, persistDocument: async () => undefined,
                bindOutput: async (input) => {
                    operationIds.add(input.operationId);
                    if (++bindCalls > 901) throw new Error("binding escaped its deadline");
                    throw new ApiError("素材尚未就绪", { status: 412, reason });
                },
                refreshTask: async () => deliveredTask,
                sleep: async (delay) => { elapsed += delay; }, now: () => elapsed,
                publishDeliveryProgress: (_, progress) => published.push(progress),
            },
        });
        await expect(binding).rejects.toBeInstanceOf(CanvasGenerationMaterializationError);
        expect(elapsed).toBe(15 * 60 * 1000);
        expect(bindCalls).toBeLessThanOrEqual(900);
        expect(operationIds.size).toBe(1);
        expect(published.at(-1)).toBeUndefined();
    });

    test.each(["delivery_paused", "delivery_timed_out"])("stops observing %s without binding or submitting another generation", async (stage) => {
        const identity = captured("user-a", 1);
        const published: unknown[] = [];
        let refreshes = 0;
        const binding = bindBackendCanvasGenerationResult({
            canvasId: "canvas-1", nodeId: "node-1", isCurrent: () => true,
            task: mediaTask({ outputs: [{ outputIndex: 0, mediaType: "video" }] }),
            nodesRef: { current: [] }, setNodes: () => { throw new Error("unfinished result must not change the canvas"); },
            runtime: {
                captureScope: () => identity, liveScope: () => identity,
                hydrateOutputs: async () => { throw new Error("unfinished result must not hydrate"); },
                bindOutput: async () => { throw new Error("unfinished result must not bind"); },
                refreshTask: async () => {
                    if (++refreshes > 1) throw new Error("paused delivery must stop polling");
                    return mediaTask({ stage, outputs: [{ outputIndex: 0, mediaType: "video", materializationErrorCode: stage }] });
                },
                sleep: async () => undefined, now: () => 0,
                publishDeliveryProgress: (_, progress) => published.push(progress),
            },
        });
        await expect(binding).rejects.toBeInstanceOf(CanvasGenerationMaterializationError);
        expect(refreshes).toBe(1);
        expect(published.at(-1)).toBeUndefined();
    });

    test("publishes fetch progress while waiting and clears it once delivered", async () => {
        const loading = canvasNode("node-1", { taskId: "task-1", status: "loading" });
        const project = canvasProject("canvas-1", [{ ...loading, metadata: { ...loading.metadata, status: "success", content: "/api/resources/res-1/file" } }], 4);
        useCanvasStore.setState({ projects: [canvasProject("canvas-1", [loading], 3)] });
        const nodesRef = { current: [loading] };
        const identity = captured("user-a", 1);
        const downloading = (downloadedBytes: number, state: "downloading" | "retrying" = "downloading") =>
            mediaTask({ outputs: [{ outputIndex: 0, mediaType: "video" }], delivery: { outputs: [{ outputIndex: 0, downloadedBytes, totalBytes: 4_000_000, bytesPerSecond: 1_000_000, state }] } });
        const sequence = [downloading(2_000_000, "retrying"), downloading(3_000_000), mediaTask({ outputs: [{ outputIndex: 0, mediaType: "video", materializedAssetId: "generation_abc" }] })];
        const published: Array<number | undefined> = [];

        await applyLikeCaller({
            canvasId: "canvas-1",
            nodeId: "node-1",
            task: downloading(1_000_000),
            isCurrent: () => true,
            nodesRef,
            setNodes: (value) => {
                nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
            },
            runtime: {
                hydrateOutputs: async () => undefined,
                persistDocument: async () => undefined,
                bindOutput: async (input) => bindResponse(input.operationId, project, "node-1"),
                adoptConfirmedProjection: async (adopted) => adopted,
                captureScope: () => identity,
                liveScope: () => identity,
                refreshTask: async () => sequence.shift()!,
                sleep: async () => undefined,
                now: () => Date.now(),
                publishDeliveryProgress: (taskId, progress) => {
                    expect(taskId).toBe("task-1");
                    published.push(progress?.downloadedBytes);
                },
            },
        });

        expect(published).toEqual([1_000_000, 2_000_000, 3_000_000, undefined, undefined]);
    });
});


test("missing logical output fails immediately without aliasing a sparse output or polling", async () => {
    const identity = captured("user-a", 1);
    let calls = 0;
    const task = mediaTask({ outputs: [{ outputIndex: 3, mediaType: "image", materializedAssetId: "fourth" }] });
    const caught = await bindBackendCanvasGenerationResult({
        canvasId: "missing-index", nodeId: "second", task, outputIndex: 0,
        isCurrent: () => true, nodesRef: { current: [] }, setNodes: () => undefined,
        runtime: { captureScope: () => identity, liveScope: () => identity,
            refreshTask: async () => { calls++; return task; },
            hydrateOutputs: async () => { calls++; },
            bindOutput: async () => { calls++; throw new Error("must not bind another image"); },
        },
    }).catch((error) => error);
    expect(caught.code).toBe("results_missing");
    expect(calls).toBe(0);
});
