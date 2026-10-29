import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvasOwnerLifetime } from "@/pages/canvas/canvas-owner-epoch";
import {
    persistOwnedCanvasUploadNode,
    shouldSuppressOwnedCanvasCallback,
    type PersistOwnedCanvasUploadNodeDeps,
} from "@/pages/canvas/canvas-upload-ownership";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
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

function persistDeps(overrides: Partial<PersistOwnedCanvasUploadNodeDeps> = {}): PersistOwnedCanvasUploadNodeDeps {
    return {
        ensureCanvasNodeAsset: async () => ({ assetId: "asset-1", created: true, linkedToProject: true, confirmed: true }),
        setNodes: () => {},
        invalidateProject: async () => {},
        warn: () => {},
        ...overrides,
    };
}

const read = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src", path), "utf8");

describe("persistOwnedCanvasUploadNode", () => {
    test("deferred React updater does not modify replacement canvas nodes", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        let queued: ((current: CanvasNodeData[]) => CanvasNodeData[]) | undefined;
        try {
            await persistOwnedCanvasUploadNode({
                owner: lifetime.capture("canvas-a"),
                expectedScope: captureUserScope(),
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({ setNodes: (updater) => { queued = updater; } }));
            expect(queued).toBeDefined();
            lifetime.invalidate();
            const replacement = [imageNode("media-1")];
            expect(queued!(replacement)).toBe(replacement);
            expect(replacement[0].metadata?.assetId).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("confirmed persist writes assetId synchronously to nodesRef and setNodes, invalidates project, and reports saved", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const nodesRef = { current: [imageNode("media-1")] };
        const setNodesCalls: string[][] = [];
        const invalidated: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                nodesRef,
                setNodes: (updater) => {
                    setNodesCalls.push(updater([imageNode("media-1")]).map((node) => String(node.metadata?.assetId || "")));
                },
                invalidateProject: async (projectId) => { invalidated.push(projectId); },
            }));
            expect(result).toEqual({ applied: true, confirmed: true, assetId: "asset-1", linkedToProject: true });
            expect(nodesRef.current[0]?.metadata?.assetId).toBe("asset-1");
            expect(setNodesCalls).toEqual([["asset-1"]]);
            expect(invalidated).toEqual(["project-a"]);
        } finally {
            restore();
        }
    });

    test("unconfirmed result keeps the draft assetId and does not report saved", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const setNodesCalls: string[][] = [];
        let invalidated = 0;
        const warnings: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "draft-1", created: true, linkedToProject: false, confirmed: false }),
                setNodes: (updater) => {
                    setNodesCalls.push(updater([imageNode("media-1")]).map((node) => String(node.metadata?.assetId || "")));
                },
                invalidateProject: async () => { invalidated += 1; },
                warn: (text) => warnings.push(text),
            }));
            expect(result).toEqual({ applied: true, confirmed: false, assetId: "draft-1", linkedToProject: false });
            expect(setNodesCalls).toEqual([["draft-1"]]);
            expect(invalidated).toBe(0);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("A to B to A while ensure is awaiting does not setNodes, invalidate, or warn", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        const setNodesCalls: unknown[] = [];
        const warnings: string[] = [];
        let invalidated = 0;
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
                setNodes: (updater) => { setNodesCalls.push(updater([imageNode("live-b")])); },
                invalidateProject: async () => { invalidated += 1; },
                warn: (text) => warnings.push(text),
            }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            const result = await pending;
            expect(result.applied).toBe(false);
            expect(result.confirmed).toBe(false);
            expect(setNodesCalls).toEqual([]);
            expect(invalidated).toBe(0);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("canvas switch while ensure is awaiting does not overlay live nodes", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        let liveCanvasId = "canvas-a";
        const setNodesCalls: unknown[] = [];
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => liveCanvasId,
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
                setNodes: (updater) => { setNodesCalls.push(updater([imageNode("live-b")])); },
            }));
            await entered.promise;
            liveCanvasId = "canvas-b";
            gate.resolve();
            const result = await pending;
            expect(result.applied).toBe(false);
            expect(result.confirmed).toBe(false);
            expect(setNodesCalls).toEqual([]);
        } finally {
            restore();
        }
    });

    test("ordinary ensure error after account switch does not write a replacement error", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        const warnings: string[] = [];
        const setNodesCalls: unknown[] = [];
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    throw new Error("网络中断");
                },
                setNodes: (updater) => { setNodesCalls.push(updater([imageNode("live-b")])); },
                warn: (text) => warnings.push(text),
            }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            const result = await pending;
            expect(result).toEqual({ applied: false, confirmed: false });
            expect(setNodesCalls).toEqual([]);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("ordinary ensure error while still owned still warns", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const warnings: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => { throw new Error("素材库不可用"); },
                warn: (text) => warnings.push(text),
            }));
            expect(result.applied).toBe(false);
            expect(result.confirmed).toBe(false);
            expect(result.error).toBeInstanceOf(Error);
            expect((result.error as Error).message).toBe("素材库不可用");
            expect(warnings.some((text) => text.includes("素材库不可用"))).toBe(true);
        } finally {
            restore();
        }
    });

    test("default source stays canvas-upload; editor source and category are forwarded", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const received: Array<{ source?: string; category?: string; hasScope: boolean; hasSignal: boolean }> = [];
        try {
            await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async (options) => {
                    received.push({ source: options.source, category: options.category, hasScope: Boolean(options.expectedScope), hasSignal: Boolean(options.signal) });
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
            }));
            const controller = new AbortController();
            await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
                signal: controller.signal,
                source: "canvas-manual",
                category: "character",
            }, persistDeps({
                ensureCanvasNodeAsset: async (options) => {
                    received.push({ source: options.source, category: options.category, hasScope: options.expectedScope === expectedScope, hasSignal: options.signal === controller.signal });
                    return { assetId: "asset-2", created: true, linkedToProject: false, confirmed: true };
                },
            }));
            expect(received).toEqual([
                { source: "canvas-upload", category: undefined, hasScope: true, hasSignal: false },
                { source: "canvas-manual", category: "character", hasScope: true, hasSignal: true },
            ]);
        } finally {
            restore();
        }
    });

    test("delayed setNodes updater after A to B to A does not overlay live nodes", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        let queued: ((current: CanvasNodeData[]) => CanvasNodeData[]) | undefined;
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                setNodes: (updater) => { queued = updater; },
            }));
            expect(result.applied).toBe(true);
            expect(queued).toBeTypeOf("function");
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            const live = [imageNode("live-b")];
            expect(queued!(live)).toBe(live);
        } finally {
            restore();
        }
    });
});

describe("shouldSuppressOwnedCanvasCallback", () => {
    test("ordinary rejected upload after canvas lifetime change is suppressed", () => {
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const expectedScope = { userScope: "owner-a", epoch: 1 };
        lifetime.invalidate();
        expect(shouldSuppressOwnedCanvasCallback(new Error("网络中断"), {
            owner,
            liveCanvasId: "canvas-a",
            expectedScope,
            liveLifetime: lifetime.current(),
        })).toBe(true);
    });

    test("ordinary error on the captured canvas is not suppressed", () => {
        const lifetime = createCanvasOwnerLifetime();
        const restore = switchScope("owner-a");
        try {
            const expectedScope = captureUserScope();
            const owner = lifetime.capture("canvas-a");
            expect(shouldSuppressOwnedCanvasCallback(new Error("网络中断"), {
                owner,
                liveCanvasId: "canvas-a",
                expectedScope,
                liveLifetime: lifetime.current(),
            })).toBe(false);
            expect(shouldSuppressOwnedCanvasCallback(new UserScopeAbandonedError(), {
                owner,
                liveCanvasId: "canvas-a",
                expectedScope,
                liveLifetime: lifetime.current(),
            })).toBe(true);
        } finally {
            restore();
        }
    });
});

test("upload hook threads owner scope through persist, file, image, chapter and timeline waits", () => {
    const hook = read("pages/canvas/use-canvas-upload.ts");
    const persist = hook.slice(hook.indexOf("const persistMediaNode"), hook.indexOf("const persistTimelineMedia"));
    expect(persist).toContain("persistOwnedCanvasUploadNode");
    expect(persist).toContain("return result.confirmed");
    expect(persist).not.toContain("return true");

    const create = hook.slice(hook.indexOf("const createFileNode"), hook.indexOf("const createImageAssetNode"));
    expect(create).toContain("uploadImage(file, onProgress, guard.expectedScope)");
    expect(create).toContain("uploadMediaFile(file, \"file\", onProgress, guard.expectedScope)");
    expect(create).toContain("shouldSuppressOwnedCanvasCallback(error,");
    expect(create.indexOf("shouldSuppressOwnedCanvasCallback")).toBeLessThan(create.indexOf("message.error(details)"));

    const image = hook.slice(hook.indexOf("const createImageAssetNode"), hook.indexOf("const createTextNodeFromClipboard"));
    expect(image).toContain("uploadImage(content, undefined, guard.expectedScope)");
    expect(image).toContain("if (guard.suppress(error)) return");

    const chapter = hook.slice(hook.indexOf("const handleProjectChapterInsert"), hook.indexOf("const handleUploadRequest"));
    expect(chapter).toContain("getProjectUnit(chapter.projectId, chapter.id, guard.expectedScope, guard.signal)");
    expect(chapter).toContain("if (!guard.alive()) return");

    const timeline = hook.slice(hook.indexOf("const uploadTimelineMedia"), hook.indexOf("const createVideoNodeFromBlob"));
    expect(timeline).toContain("uploadMediaFile(file, \"audio\", undefined, guard.expectedScope)");
    expect(timeline).toContain("persistTimelineMedia(media, guard.expectedScope, guard.signal)");
    expect(timeline).toContain("if (guard.suppress(error)) return []");
});

test("node editor threads owner scope through category change and save, and keeps confirmed=false draft copy", () => {
    const editor = read("pages/canvas/use-canvas-node-editor.ts");
    expect(editor).toContain("useCanvasOwnerLifetime(canvasId)");
    expect(editor).toContain("createOwnedCanvasUploadGuard");
    expect(editor).toContain("persistOwnedCanvasUploadNode");
    expect(editor).toContain("source: \"canvas-manual\"");
    expect(editor).toContain("category,");

    const persist = editor.slice(editor.indexOf("const persistOwnedEditorNode"), editor.indexOf("const handleConfigNodeChange"));
    expect(persist).toContain("expectedScope: guard.expectedScope");
    expect(persist).toContain("signal: guard.signal");
    expect(persist).not.toContain("warn:");

    const config = editor.slice(editor.indexOf("const handleConfigNodeChange"), editor.indexOf("const downloadNodeImage"));
    expect(config).toContain("applyNodeConfigPatch(node, patch)");
    expect(config).toContain("nodesRef.current = next");
    expect(config).toContain("persistOwnedEditorNode(updatedNode, patch.assetCategory)");
    expect(config).toContain("if (!guard.alive()) return");
    expect(config).toContain("message.success(\"资产分类已更新\")");
    expect(config).toContain("文件目前只在这台设备上");
    expect(config).toContain("资产分类更新失败");
    expect(config.indexOf("if (!guard.alive())")).toBeLessThan(config.indexOf("message.success(\"资产分类已更新\")"));
    expect(config.indexOf("if (!guard.alive())")).toBeLessThan(config.indexOf("资产分类更新失败"));

    const save = editor.slice(editor.indexOf("const saveNodeAsset"), editor.indexOf("const handleFontSizeChange"));
    expect(save).toContain("persistOwnedEditorNode(node)");
    expect(save).toContain("if (!guard.alive()) return");
    expect(save).toContain("if (!result.confirmed) message.warning");
    expect(save).toContain("文件目前只在这台设备上");
    expect(save).toContain("已加入项目资产");
    expect(save).toContain("已加入我的素材");
    expect(save).toContain("素材保存失败");
    expect(save.indexOf("if (!guard.alive())")).toBeLessThan(save.indexOf("if (!result.confirmed) message.warning"));
    expect(save.indexOf("if (!guard.alive())")).toBeLessThan(save.indexOf("素材保存失败"));
});
