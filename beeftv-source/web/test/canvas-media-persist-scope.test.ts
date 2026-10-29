import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    CanvasMediaPersistUnconfirmedError,
    persistOwnedCanvasMediaNodes,
    type PersistOwnedCanvasMediaNodesDeps,
} from "@/lib/canvas/canvas-media-persist";
import { recoverOwnedDepthCaptureNode, recoverOwnedDepthCaptureNodes } from "@/lib/canvas/canvas-depth-recover";
import { beginLocalExecutorSession, isLocalExecutorSessionStop } from "@/lib/plugins/builtin/editor/local-executor-session";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function imageNode(id: string, extra: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 8,
        height: 8,
        metadata: { content: "data:image/png;base64,xx", ...extra },
    };
}

function depthNode(id: string, extra: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Video,
        title: id,
        position: { x: 0, y: 0 },
        width: 16,
        height: 9,
        metadata: {
            status: "loading",
            depthSourceNodeId: "source-1",
            taskId: "depth-task",
            ...extra,
        },
    };
}

function envelope(data: unknown) {
    return { data: { code: 0, data, msg: "" }, status: 200, statusText: "OK", headers: {}, config: {} as never };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

function generationTask(partial: Partial<GenerationTask> & Pick<GenerationTask, "id">): GenerationTask {
    return {
        type: "depth_capture",
        status: "queued",
        prompt: "",
        attempts: 0,
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        ...partial,
    };
}

function persistDeps(overrides: Partial<PersistOwnedCanvasMediaNodesDeps> & Pick<PersistOwnedCanvasMediaNodesDeps, "ensureCanvasNodeAsset" | "getLiveProjectId" | "getLiveNodes">): PersistOwnedCanvasMediaNodesDeps {
    return {
        getStoredProject: () => ({ nodes: overrides.getLiveNodes(), connections: [] }),
        hasProject: () => true,
        updateProject: () => undefined,
        flushPersistence: async () => undefined,
        setNodes: () => undefined,
        getLiveConnections: () => [],
        isLocalWorkspace: () => false,
        ...overrides,
    };
}

describe("persistOwnedCanvasMediaNodes interior ownership", () => {
    test("project switch while ensure is awaiting does not overlay live nodes, setNodes, or ack save", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        let liveProject = "proj-a";
        let liveNodes = [imageNode("live-a")];
        const setNodesCalls: CanvasNodeData[][] = [];
        const updates: Array<{ id: string; nodes: string[] }> = [];
        const media = imageNode("media-1");
        try {
            const pending = persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [media],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
                getLiveProjectId: () => liveProject,
                getLiveNodes: () => liveNodes,
                setNodes: (updater) => { setNodesCalls.push(updater(liveNodes)); },
                updateProject: (id, patch) => { updates.push({ id, nodes: patch.nodes.map((node) => node.id) }); },
            }));
            await entered.promise;
            liveProject = "proj-b";
            liveNodes = [imageNode("live-b")];
            gate.resolve();
            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
            expect(setNodesCalls).toEqual([]);
            expect(updates).toEqual([]);
        } finally {
            restore();
        }
    });

    test("A to B to A while ensure is awaiting does not write the original canvas", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        const updates: unknown[] = [];
        try {
            const pending = persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [imageNode("media-1")],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
                getLiveProjectId: () => "proj-a",
                getLiveNodes: () => [imageNode("live-a")],
                updateProject: (_id, patch) => { updates.push(patch); },
            }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(updates).toEqual([]);
        } finally {
            restore();
        }
    });

    test("unconfirmed asset result does not updateProject, flush, or ack save", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        let flushed = 0;
        let synced = 0;
        let readBack = 0;
        const updates: unknown[] = [];
        const setNodesCalls: unknown[] = [];
        try {
            await expect(persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [imageNode("media-1")],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "draft-1", created: true, linkedToProject: false, confirmed: false }),
                getLiveProjectId: () => "proj-a",
                getLiveNodes: () => [],
                setNodes: (updater) => { setNodesCalls.push(updater([])); },
                updateProject: (_id, patch) => { updates.push(patch); },
                flushPersistence: async () => { flushed += 1; },
                isLocalWorkspace: () => true,
                syncSnapshot: async () => { synced += 1; },
                readSavedProject: async () => {
                    readBack += 1;
                    return { nodes: [] };
                },
            }))).rejects.toBeInstanceOf(CanvasMediaPersistUnconfirmedError);
            expect(updates).toEqual([]);
            expect(setNodesCalls).toEqual([]);
            expect(flushed).toBe(0);
            expect(synced).toBe(0);
            expect(readBack).toBe(0);
        } finally {
            restore();
        }
    });

    test("ordinary ensure error after project switch does not warn", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        let liveProject = "proj-a";
        const warnings: string[] = [];
        const errors: string[] = [];
        try {
            const pending = persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [imageNode("media-1")],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    throw new Error("network down");
                },
                getLiveProjectId: () => liveProject,
                getLiveNodes: () => [],
                warn: (text) => { warnings.push(text); },
                error: (text) => { errors.push(text); },
            }));
            await entered.promise;
            liveProject = "proj-b";
            gate.resolve();
            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
            expect(warnings).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            restore();
        }
    });

    test("ordinary flush error after project switch or A to B to A does not toast", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const switchEntered = deferred();
        const switchGate = deferred();
        const abaEntered = deferred();
        const abaGate = deferred();
        let liveProject = "proj-a";
        const switchErrors: string[] = [];
        const abaErrors: string[] = [];
        try {
            const switched = persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [imageNode("media-1")],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "asset-1", created: true, linkedToProject: true, confirmed: true }),
                getLiveProjectId: () => liveProject,
                getLiveNodes: () => [],
                flushPersistence: async () => {
                    switchEntered.resolve();
                    await switchGate.promise;
                    throw new Error("flush failed");
                },
                error: (text) => { switchErrors.push(text); },
            }));
            await switchEntered.promise;
            liveProject = "proj-b";
            switchGate.resolve();
            await expect(switched).rejects.toMatchObject({ name: "AbortError" });
            expect(switchErrors).toEqual([]);

            const aba = persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [imageNode("media-2")],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "asset-2", created: true, linkedToProject: true, confirmed: true }),
                getLiveProjectId: () => "proj-a",
                getLiveNodes: () => [],
                flushPersistence: async () => {
                    abaEntered.resolve();
                    await abaGate.promise;
                    throw new Error("flush failed");
                },
                error: (text) => { abaErrors.push(text); },
            }));
            await abaEntered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            abaGate.resolve();
            await expect(aba).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(abaErrors).toEqual([]);
        } finally {
            restore();
        }
    });

    test("ordinary flush error on the original session still reports save failure", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const errors: string[] = [];
        try {
            await expect(persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [imageNode("media-1")],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "asset-1", created: true, linkedToProject: true, confirmed: true }),
                getLiveProjectId: () => "proj-a",
                getLiveNodes: () => [],
                flushPersistence: async () => {
                    throw new Error("flush failed");
                },
                error: (text) => { errors.push(text); },
            }))).rejects.toThrow("flush failed");
            expect(errors).toEqual(["媒体结果已生成，但本地画布保存失败：flush failed"]);
        } finally {
            restore();
        }
    });

    test("open, flush, and sync receive the captured expectedScope", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const media = imageNode("media-1");
        let exists = false;
        const opened: CapturedUserScope[] = [];
        const flushed: CapturedUserScope[] = [];
        const synced: CapturedUserScope[] = [];
        try {
            await persistOwnedCanvasMediaNodes({
                canvasId: "proj-a",
                mediaNodes: [media],
                expectedScope,
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "asset-1", created: true, linkedToProject: true, confirmed: true }),
                getLiveProjectId: () => "proj-a",
                getLiveNodes: () => [],
                hasProject: () => exists,
                openProject: async (_id, scope) => {
                    opened.push(scope);
                    exists = true;
                },
                flushPersistence: async (scope) => { flushed.push(scope); },
                isLocalWorkspace: () => true,
                syncSnapshot: async (_id, _patch, scope) => { synced.push(scope); },
                readSavedProject: async () => ({ nodes: [{ ...media, metadata: { ...media.metadata, assetId: "asset-1" } }] }),
            }));
            expect(opened).toEqual([expectedScope]);
            expect(flushed).toEqual([expectedScope]);
            expect(synced).toEqual([expectedScope]);
        } finally {
            restore();
        }
    });
});

describe("recoverOwnedDepthCaptureNodes ownership", () => {
    test("recovery completion after project switch does not persist, write replacement nodes, or cancel the task", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const pollEntered = deferred();
        const pollGate = deferred();
        let liveProject = "proj-a";
        const controller = new AbortController();
        let persistCalls = 0;
        const nodeWrites: string[] = [];
        const urls: string[] = [];
        const node = depthNode("depth-1");
        try {
            await withAdapter(async (config) => {
                const path = String(config.url || "");
                urls.push(`${config.method}:${path}`);
                if (path === "/tasks/depth-task") {
                    pollEntered.resolve();
                    await pollGate.promise;
                    return envelope(generationTask({
                        id: "depth-task",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "depth-out", fileName: "depth.mp4", size: 1, durationMs: 1000, width: 16, height: 9 }),
                    }));
                }
                if (path === "/resources/depth-out") {
                    persistCalls += 100;
                    return envelope({ resource: { id: "depth-out", mimeType: "video/mp4", size: 1, width: 16, height: 9, durationMs: 1000 } });
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                const session = beginLocalExecutorSession("proj-a", {
                    controller,
                    getLiveProjectId: () => liveProject,
                    expectedScope,
                });
                const pending = recoverOwnedDepthCaptureNode({
                    node,
                    session,
                    nodesRef: { current: [depthNode("depth-1")] },
                    setNodes: (updater) => {
                        const next = updater([node]);
                        nodeWrites.push(next.find((item) => item.id === node.id)?.metadata?.status || "");
                    },
                });
                await pollEntered.promise;
                liveProject = "proj-b";
                controller.abort();
                pollGate.resolve();
                await pending;
                expect(isLocalExecutorSessionStop(new DOMException("Aborted", "AbortError"))).toBe(true);
                expect(persistCalls).toBe(0);
                expect(nodeWrites.some((status) => status === "success" || status === "error")).toBe(false);
                expect(urls.some((url) => url.includes("cancel") || url.startsWith("DELETE"))).toBe(false);
            });
        } finally {
            pollGate.resolve();
            restore();
        }
    });

    test("recoverOwnedDepthCaptureNodes aborts observation on the caller signal without cancelling the durable task", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const pollEntered = deferred();
        const pollGate = deferred();
        const signal = new AbortController();
        const observers = new Set<AbortController>();
        let persistCalls = 0;
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                const path = String(config.url || "");
                urls.push(`${config.method}:${path}`);
                if (path === "/tasks/depth-task") {
                    pollEntered.resolve();
                    await pollGate.promise;
                    return envelope(generationTask({
                        id: "depth-task",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "depth-out" }),
                    }));
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                recoverOwnedDepthCaptureNodes({
                    signal: signal.signal,
                    expectedScope,
                    projectId: "proj-a",
                    getLiveProjectId: () => "proj-a",
                    observers,
                    nodesRef: { current: [depthNode("depth-1")] },
                    setNodes: () => undefined,
                });
                await pollEntered.promise;
                expect(observers.size).toBe(1);
                signal.abort();
                pollGate.resolve();
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(persistCalls).toBe(0);
                expect(urls.some((url) => url.includes("cancel") || url.startsWith("DELETE"))).toBe(false);
            });
        } finally {
            pollGate.resolve();
            restore();
        }
    });

    test("ordinary binding error after project switch does not write failed metadata", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = captureUserScope();
        const lookupEntered = deferred();
        const lookupGate = deferred();
        let liveProject = "proj-a";
        const controller = new AbortController();
        const nodeWrites: string[] = [];
        const node = depthNode("depth-1");
        try {
            await withAdapter(async (config) => {
                const path = String(config.url || "");
                if (path === "/tasks/depth-task") {
                    return envelope(generationTask({
                        id: "depth-task",
                        status: "succeeded",
                        resultJson: JSON.stringify({ resourceId: "depth-out", fileName: "depth.mp4", size: 1, durationMs: 1000, width: 16, height: 9 }),
                    }));
                }
                if (path === "/resources/depth-out") {
                    lookupEntered.resolve();
                    await lookupGate.promise;
                    throw new Error("lookup failed");
                }
                throw new Error(`unexpected ${path}`);
            }, async () => {
                const session = beginLocalExecutorSession("proj-a", {
                    controller,
                    getLiveProjectId: () => liveProject,
                    expectedScope,
                });
                const pending = recoverOwnedDepthCaptureNode({
                    node,
                    session,
                    nodesRef: { current: [node] },
                    setNodes: (updater) => {
                        const next = updater([node]);
                        nodeWrites.push(next.find((item) => item.id === node.id)?.metadata?.status || "");
                    },
                }, async () => {
                    lookupEntered.resolve();
                    await lookupGate.promise;
                    throw new Error("binding failed");
                });
                await lookupEntered.promise;
                liveProject = "proj-b";
                lookupGate.resolve();
                await pending;
                expect(controller.signal.aborted).toBe(true);
                expect(nodeWrites.some((status) => status === "error" || status === "success")).toBe(false);
            });
        } finally {
            lookupGate.resolve();
            restore();
        }
    });
});

describe("owned canvas persist and recover callbacks", () => {
    test("reopening a stale failure restores running state then records the real local failure", async () => {
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
        Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; }, clearTimeout: () => {} } });
        const restore = switchScope("owner-a");
        const node = depthNode("depth-1", { status: "error", errorDetails: "任务执行超时，请稍后重试" });
        const nodesRef = { current: [node] };
        const states: string[] = [];
        let queries = 0;
        try {
            await withAdapter(async config => {
                expect(config.method).toBe("get");
                expect(config.url).toBe("/tasks/depth-task");
                queries++;
                return envelope(generationTask({ id: "depth-task", provider: "local", model: "video-depth-anything-small", status: queries === 1 ? "running" : "failed", stage: queries === 1 ? "分析视频" : "深度处理失败", error: queries === 1 ? undefined : "curl: (28) Connection timed out" }));
            }, async () => {
                await recoverOwnedDepthCaptureNode({ node, nodesRef,
                    session: beginLocalExecutorSession("proj-a", { controller: new AbortController(), getLiveProjectId: () => "proj-a" }),
                    setNodes: updater => { nodesRef.current = updater(nodesRef.current); states.push(nodesRef.current[0]?.metadata?.status || ""); },
                }, async () => { throw new Error("failed task must not bind"); });
                expect(states).toContain("loading");
                expect(nodesRef.current[0]?.metadata).toMatchObject({ status: "error", taskId: "depth-task", taskStatus: "failed", taskStage: "深度处理失败", taskProvider: "local", errorDetails: "curl: (28) Connection timed out", taskClientOperationTerminal: true });
            });
        } finally {
            restore();
            if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
            else Reflect.deleteProperty(globalThis, "window");
        }
    });
    test("reopening after an attachment failure retries the same task, preserving concurrent edits", async () => {
        const restore = switchScope("owner-a");
        const node = depthNode("depth-1");
        node.metadata = { ...node.metadata, status: "error", taskStatus: "failed" };
        const nodesRef = { current: [{ ...node, title: "用户改名", position: { x: 99, y: 88 } }] };
        const methods: string[] = [];
        let binds = 0;
        try {
            await withAdapter(async config => {
                methods.push(String(config.method));
                if (config.url === "/tasks/depth-task") return envelope(generationTask({ id: "depth-task", status: "succeeded", resultJson: JSON.stringify({ resourceId: "depth-out" }) }));
                throw new Error(`unexpected ${config.url}`);
            }, async () => {
                const input = { node, nodesRef,
                    session: beginLocalExecutorSession("proj-a", { controller: new AbortController(), getLiveProjectId: () => "proj-a" }),
                    setNodes: (updater: (current: CanvasNodeData[]) => CanvasNodeData[]) => { nodesRef.current = updater(nodesRef.current); },
                };
                const bind: Parameters<typeof recoverOwnedDepthCaptureNode>[1] = async args => {
                    binds++;
                    expect(args.task.id).toBe("depth-task");
                    expect(args.nodesRef.current[0]?.title).toBe("用户改名");
                    if (binds === 1) throw new Error("canvas conflict");
                    args.setNodes(current => current.map(item => ({ ...item, metadata: { ...item.metadata, status: "success", storageKey: "resource:depth-out" } })));
                };
                await recoverOwnedDepthCaptureNode(input, bind);
                expect(nodesRef.current[0]?.metadata?.status).toBe("error");
                expect(nodesRef.current[0]?.metadata?.taskStatus).toBe("succeeded");
                await recoverOwnedDepthCaptureNode(input, bind);
                expect(nodesRef.current[0]?.metadata?.status).toBe("success");
                expect(nodesRef.current[0]?.position).toEqual({ x: 99, y: 88 });
                expect(binds).toBe(2);
                expect(methods.every(method => method === "get")).toBe(true);
            });
        } finally { restore(); }
    });
    test("recovery ignores deleted or replaced targets after polling", async () => {
        for (const replaced of [false, true]) {
            const restore = switchScope("owner-a");
            const node = depthNode("depth-1");
            const nodesRef: { current: CanvasNodeData[] } = { current: [node] };
            let binds = 0;
            try {
                await withAdapter(async () => {
                    nodesRef.current = replaced ? [{ ...node, metadata: { ...node.metadata, taskId: "new-task" } }] : [];
                    return envelope(generationTask({ id: "depth-task", status: "succeeded" }));
                }, async () => {
                    await recoverOwnedDepthCaptureNode({
                        node, nodesRef, session: beginLocalExecutorSession("proj-a", { controller: new AbortController(), getLiveProjectId: () => "proj-a" }),
                        setNodes: updater => { nodesRef.current = updater(nodesRef.current); },
                    }, async () => { binds++; });
                    expect(binds).toBe(0);
                    expect(nodesRef.current.length).toBe(replaced ? 1 : 0);
                    if (replaced) expect(nodesRef.current[0]?.metadata?.taskId).toBe("new-task");
                });
            } finally { restore(); }
        }
    });
    test("canvas media tools persist and recover through the owned helpers", () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const tools = readFileSync(join(here, "../src/pages/canvas/use-canvas-media-tools.ts"), "utf8");
        expect(tools).toContain("persistOwnedCanvasMediaNodes(");
        expect(tools).toContain("recoverOwnedDepthCaptureNodes(");
        expect(tools).toContain("taskClientOperationInput");
        expect(tools).toContain("taskClientOperationTerminal");
        expect(tools).toContain("nextLocalExecutorClientOperationId(");
        expect(tools).toContain("localExecutorFrozenInputKey([\"depth_capture\"");
        expect(tools).toContain("openLocalCanvasProjectFromBackend(id, expectedScope)");
        expect(tools).toContain("syncLocalCanvasSnapshot(id, patch, expectedScope)");
        expect(tools).toContain("assertUserScope(expectedScope)");
        const exportSource = readFileSync(join(here, "../src/lib/plugins/builtin/editor/editor-export.tsx"), "utf8");
        expect(exportSource).toContain("nextLocalExecutorClientOperationId(submitIntentRef.current, frozenInputKey)");
        const transcription = readFileSync(join(here, "../src/lib/plugins/builtin/editor/editor-transcription.tsx"), "utf8");
        expect(transcription).toContain("nextLocalExecutorClientOperationId(submitIntentRef.current, frozenInputKey)");
    });
});
