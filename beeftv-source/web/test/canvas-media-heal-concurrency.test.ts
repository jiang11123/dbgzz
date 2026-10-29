import { beforeEach, expect, test } from "bun:test";
import { captureUserScope } from "@/lib/user-scope-guard";
import { ApiError } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { healCanvasProjectMediaAssets, persistCanvasGenerationTarget } from "@/services/canvas-generation-target";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

function media(id: string, resource = id): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { storageKey: `resource:${resource}`, content: `/api/resources/${resource}/file` } };
}

function clip(id: string, resource = id): TimelineClip {
    return { id, kind: "video", nodeId: id, trackId: "track", startMs: 0, durationMs: 1000, directMedia: { id: `media-${id}`, kind: "video", title: id, storageKey: `resource:${resource}` } };
}

function timeline(clips: TimelineClip[]): TimelineProject {
    return { version: 2, tracks: [{ id: "track", kind: "video", label: "视频", order: 0 }], clips, durationMs: 1000 };
}

function project(nodes: CanvasNodeData[], track?: TimelineProject): CanvasProject {
    return { id: "heal-canvas", title: "画布", createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 3, nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [], timeline: track };
}

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

const guardError = () => new ApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
const ensured = (id: string) => ({ assetId: `asset-${id}`, created: true, linkedToProject: false, confirmed: true });
beforeEach(() => { useAssetStore.setState({ assets: [] }); useCanvasStore.setState({ projects: [] }); });

test("media heal preserves concurrent node and timeline edits, additions, deletions and resource replacements", async () => {
    const initial = project([media("edited"), media("deleted"), media("replaced"), media("rebound")], timeline([clip("edited"), clip("deleted"), clip("replaced"), clip("rebound")]));
    useCanvasStore.setState({ projects: [initial] });
    const nodesRef = { current: initial.nodes };
    const started = gate(), release = gate();
    const pending = healCanvasProjectMediaAssets(initial, {
        expectedScope: captureUserScope(), isCurrent: () => true, nodesRef,
        setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
        ensureNodeAsset: async ({ node }) => { started.resolve(); await release.promise; return ensured(node.id); },
    });
    await started.promise;
    const changedNodes = [
        { ...media("edited"), title: "new title", position: { x: 500, y: 600 }, metadata: { ...media("edited").metadata, prompt: "new prompt" } },
        media("replaced", "new-resource"),
        { ...media("rebound"), metadata: { ...media("rebound").metadata, assetId: "asset-selected-later" } },
        media("added"),
    ];
    const changedTimeline = {
        ...timeline([
            { ...clip("edited"), startMs: 400, durationMs: 700, volume: 0.5 },
            clip("replaced", "new-clip-resource"),
            { ...clip("rebound"), directMedia: { ...clip("rebound").directMedia!, assetId: "clip-asset-selected-later" } },
            clip("added"),
        ]), durationMs: 5000,
        tracks: [{ id: "track", kind: "video" as const, label: "renamed track", order: 0, muted: true }],
    };
    const changedConnections = [{ id: "new-link", fromNodeId: "edited", toNodeId: "added" }];
    useCanvasStore.getState().updateProject(initial.id, { nodes: changedNodes, connections: changedConnections, timeline: changedTimeline });
    nodesRef.current = changedNodes;
    release.resolve();
    const result = await pending;
    const live = useCanvasStore.getState().openProject(initial.id)!;
    expect(result.nodes).toEqual(live.nodes);
    expect(nodesRef.current).toEqual(live.nodes);
    expect(live.nodes.map((node) => node.id)).toEqual(["edited", "replaced", "rebound", "added"]);
    expect(live.nodes[0]).toMatchObject({ title: "new title", position: { x: 500, y: 600 }, metadata: { prompt: "new prompt", assetId: "asset-edited" } });
    expect(live.nodes[1]).toEqual(changedNodes[1]);
    expect(live.nodes[2]).toEqual(changedNodes[2]);
    expect(live.nodes[3]).toEqual(changedNodes[3]);
    expect(live.connections).toEqual(changedConnections);
    expect(live.timeline?.clips.map((item) => item.id)).toEqual(["edited", "replaced", "rebound", "added"]);
    expect(live.timeline?.clips[0]).toMatchObject({ startMs: 400, durationMs: 700, volume: 0.5, directMedia: { assetId: "asset-edited" } });
    expect(live.timeline?.clips.slice(1)).toEqual(changedTimeline.clips.slice(1));
    expect(live.timeline?.tracks).toEqual(changedTimeline.tracks);
    expect(live.timeline?.durationMs).toBe(5000);
});

test("heal starts from the latest store even if the failed save supplied an older project", async () => {
    const old = project([media("removed")]);
    const latest = { ...old, nodes: [media("current")], timeline: timeline([clip("current-clip")]) };
    useCanvasStore.setState({ projects: [latest] });
    const ensuredIds: string[] = [];
    await healCanvasProjectMediaAssets(old, { expectedScope: captureUserScope(), ensureNodeAsset: async ({ node }) => { ensuredIds.push(node.id); return ensured(node.id); } });
    expect(ensuredIds).toEqual(["current", "media-current-clip"]);
    expect(useCanvasStore.getState().openProject(old.id)?.nodes.map((node) => node.id)).toEqual(["current"]);
});

test("healing projects store bindings into a lagging page without overwriting its own edits or explicit binding", async () => {
    const node = media("reference");
    const selected = { ...media("selected"), metadata: { ...media("selected").metadata, assetId: "asset-store" } };
    const initial = project([{ ...node, metadata: { ...node.metadata, assetId: "asset-reference" } }, selected]);
    useCanvasStore.setState({ projects: [initial] });
    const nodesRef = { current: [node, { ...selected, metadata: { ...selected.metadata, assetId: "asset-page-choice" } }] };
    const result = await healCanvasProjectMediaAssets(initial, {
        expectedScope: captureUserScope(), nodesRef,
        setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
        ensureNodeAsset: async ({ node }) => {
            nodesRef.current = nodesRef.current.map((item) => item.id === "reference" ? { ...item, title: "page edit" } : item);
            return ensured(node.id);
        },
    });
    expect(result.current).toBe(true);
    expect(nodesRef.current[0]).toMatchObject({ title: "page edit", metadata: { assetId: "asset-reference" } });
    expect(nodesRef.current[1].metadata?.assetId).toBe("asset-page-choice");
});

test("deleting a canvas or its entire timeline during registration does not restore it", async () => {
    for (const deleteCanvas of [false, true]) {
        const initial = project([media("reference")], timeline([clip("clip")]));
        useCanvasStore.setState({ projects: [initial] });
        const result = await healCanvasProjectMediaAssets(initial, { expectedScope: captureUserScope(), ensureNodeAsset: async ({ node }) => {
            if (deleteCanvas) useCanvasStore.setState({ projects: [] });
            else useCanvasStore.getState().updateProject(initial.id, { timeline: undefined });
            return ensured(node.id);
        } });
        expect(result.current).toBe(!deleteCanvas);
        expect(useCanvasStore.getState().openProject(initial.id)?.timeline).toBeUndefined();
        if (deleteCanvas) expect(useCanvasStore.getState().projects).toEqual([]);
    }
});

test("target save persists concurrent edits and deleted targets stay deleted before submission", async () => {
    const target = { ...media("target"), metadata: { status: "loading" as const } };
    const initial = project([target, media("reference")]);
    useCanvasStore.setState({ projects: [initial] });
    const patches: Array<{ nodes?: CanvasNodeData[]; connections?: CanvasProject["connections"] }> = [];
    const connections = [{ id: "new-link", fromNodeId: "reference", toNodeId: "added" }];
    await expect(persistCanvasGenerationTarget({
        projectId: initial.id, nodeId: target.id, expectedScope: captureUserScope(), isCurrent: () => true,
        ensureNodeAsset: async ({ node }) => {
            useCanvasStore.getState().updateProject(initial.id, { nodes: [media("reference"), media("added")], connections });
            return ensured(node.id);
        },
    }, async (_id, patch) => { patches.push(patch); if (patches.length === 1) throw guardError(); })).rejects.toThrow("生成节点已不存在");
    for (const patch of patches.slice(1)) {
        expect(patch.nodes?.map((node) => node.id)).toEqual(["reference", "added"]);
        expect(patch.connections).toEqual(connections);
    }
    expect(patches.length).toBeGreaterThan(1);
});

for (const guardAt of ["flush", "bind"] as const) {
    test(`result consumer retries ${guardAt} with the latest nodes, connections and timeline`, async () => {
        const initial = project([media("reference")], timeline([clip("clip")]));
        useCanvasStore.setState({ projects: [initial] });
        const nodesRef = { current: initial.nodes };
        let persists = 0, binds = 0;
        const task: GenerationTask = { id: "task", type: "canvas_image", status: "succeeded", attempts: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "generated" }] };
        const connections = [{ id: "new-link", fromNodeId: "reference", toNodeId: "added" }];
        await bindBackendCanvasGenerationResult({
            canvasId: initial.id, nodeId: "target", task, nodesRef, isCurrent: () => true,
            setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
            runtime: {
                hydrateOutputs: async () => undefined,
                ensureNodeAsset: async ({ node }) => {
                    const current = useCanvasStore.getState().openProject(initial.id)!;
                    const nodes = [{ ...current.nodes[0]!, title: "edited during registration" }, media("added")];
                    useCanvasStore.getState().updateProject(initial.id, { nodes, connections, timeline: { ...current.timeline!, durationMs: 9000 } });
                    nodesRef.current = nodes;
                    return ensured(node.id);
                },
                persistDocument: async (_id, patch) => {
                    persists++;
                    if (persists === 1) { if (guardAt === "flush") throw guardError(); return; }
                    expect(patch.nodes?.map((node) => node.id)).toEqual(["reference", "added"]);
                    expect(patch.nodes?.[0]).toMatchObject({ title: "edited during registration", metadata: { assetId: "asset-reference" } });
                    expect(patch.connections).toEqual(connections);
                    expect(patch.timeline?.durationMs).toBe(9000);
                    expect(patch.timeline?.clips[0].directMedia?.assetId).toBe("asset-media-clip");
                },
                bindOutput: async (input) => {
                    binds++;
                    if (guardAt === "bind" && binds === 1) throw guardError();
                    return { op: "canvas.task.bind", opId: input.operationId, replayed: false, revision: 4, result: { bindingStatus: "deleted" } };
                },
            },
        });
        expect(persists).toBe(2);
        expect(binds).toBe(guardAt === "bind" ? 2 : 1);
    });
}
