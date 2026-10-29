import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";

import { useCanvasDirector } from "@/pages/canvas/use-canvas-director";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { apiClient } from "@/services/api/request";
import * as imageStorage from "@/services/image-storage";
import * as fileStorage from "@/services/file-storage";
import * as assetSync from "@/services/project-asset-sync";
import { resetWorkspaceAssetCommitStateForTests } from "@/services/workspace-asset-repository";
import { peekAssetStoreDraft, resetAssetStoreDraftsForTests, useAssetStore } from "@/stores/use-asset-store";
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

function directorNode(sceneId: string, shotId: string): CanvasNodeData {
    return {
        id: "director",
        type: CanvasNodeType.Director,
        title: "导演台",
        position: { x: 0, y: 0 },
        width: 640,
        height: 640,
        metadata: { workflowKind: "shot", directorSceneId: sceneId, directorShotId: shotId },
    };
}

function mountDirector(projectId: string, node: CanvasNodeData, scene: ReturnType<typeof createDirectorScene>, nodesRef: { current: CanvasNodeData[] }) {
    let director!: ReturnType<typeof useCanvasDirector>;
    function Harness() {
        director = useCanvasDirector({
            projectId,
            directorNodeId: node.id,
            directorScenes: [scene],
            nodesRef,
            connectionsRef: { current: [] },
            getCanvasCenter: () => ({ x: 0, y: 0 }),
            setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
            setConnections: () => {},
            setSelectedNodeIds: () => {},
            setSelectedConnectionId: () => {},
            setDirectorNodeId: () => {},
            updateProject: useCanvasStore.getState().updateProject,
        });
        return null;
    }
    renderToStaticMarkup(<Harness />);
    return director;
}

const spies: Array<{ mockRestore: () => void }> = [];

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
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

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetCommitStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("director cover and output captured scope", () => {
    test("cover upload receives the captured scope and ignores a delayed scene switch", async () => {
        const restore = switchScope("owner-a");
        const expected = captureUserScope();
        const scene = createDirectorScene("镜头");
        const node = directorNode(scene.id, scene.shots[0].id);
        const nodesRef = { current: [node] };
        const projectId = useCanvasStore.getState().createProject("cover scope");
        useCanvasStore.getState().updateProject(projectId, { directorScenes: [scene], nodes: [node] });
        const entered = deferred();
        const gate = deferred();
        spies.push(spyOn(App, "useApp").mockReturnValue({ message: { success: () => {}, error: () => {}, warning: () => {} } } as ReturnType<typeof App.useApp>));
        spies.push(spyOn(imageStorage, "uploadImage").mockImplementation(async (_source, _progress, scope) => {
            expect(scope).toEqual(expected);
            entered.resolve();
            await gate.promise;
            return { storageKey: "image:cover", url: "blob:cover", width: 8, height: 8, bytes: 1, mimeType: "image/png" };
        }));
        try {
            const director = mountDirector(projectId, node, scene, nodesRef);
            const pending = director.captureDirectorCover({ scene, shotId: scene.shots[0].id, beauty: new Blob(["cover"]) });
            await entered.promise;
            useCanvasStore.getState().updateProject(projectId, { directorScenes: [{ ...scene, updatedAt: "2026-10-02T12:00:00.000Z" }] });
            gate.resolve();
            await pending;
            expect(nodesRef.current[0].metadata?.directorCoverStorageKey).toBeUndefined();
        } finally {
            restore();
            useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
        }
    });

    test("A→B→A during cover upload does not write the node", async () => {
        const restore = switchScope("owner-a");
        const expected = captureUserScope();
        const scene = createDirectorScene("镜头");
        const node = directorNode(scene.id, scene.shots[0].id);
        const nodesRef = { current: [node] };
        const projectId = useCanvasStore.getState().createProject("cover aba");
        useCanvasStore.getState().updateProject(projectId, { directorScenes: [scene], nodes: [node] });
        const entered = deferred();
        const gate = deferred();
        spies.push(spyOn(App, "useApp").mockReturnValue({ message: { success: () => {}, error: () => {}, warning: () => {} } } as ReturnType<typeof App.useApp>));
        spies.push(spyOn(imageStorage, "uploadImage").mockImplementation(async (_source, _progress, scope) => {
            expect(scope).toEqual(expected);
            entered.resolve();
            await gate.promise;
            return { storageKey: "image:cover", url: "blob:cover", width: 8, height: 8, bytes: 1, mimeType: "image/png" };
        }));
        try {
            const director = mountDirector(projectId, node, scene, nodesRef);
            const pending = director.captureDirectorCover({ scene, shotId: scene.shots[0].id, beauty: new Blob(["cover"]) });
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await pending;
            expect(nodesRef.current[0].metadata?.directorCoverStorageKey).toBeUndefined();
        } finally {
            restore();
            useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
        }
    });

    test("output upload carries captured scope and stops after a delayed scene switch", async () => {
        const restore = switchScope("owner-a");
        const expected = captureUserScope();
        const scene = createDirectorScene();
        const node = directorNode(scene.id, scene.shots[0].id);
        const nodesRef = { current: [node] };
        const projectId = useCanvasStore.getState().createProject("output scene");
        useCanvasStore.getState().updateProject(projectId, { nodes: [node], directorScenes: [scene] });
        const entered = deferred();
        const gate = deferred();
        const ensure = spyOn(assetSync, "ensureCanvasNodeAsset");
        spies.push(spyOn(App, "useApp").mockReturnValue({ message: { success: () => {}, error: () => {}, warning: () => {} } } as ReturnType<typeof App.useApp>));
        spies.push(spyOn(imageStorage, "uploadImage").mockImplementation(async (_source, _progress, scope) => {
            expect(scope).toEqual(expected);
            entered.resolve();
            await gate.promise;
            return { storageKey: "image:output", url: "blob:output", width: 8, height: 8, bytes: 1, mimeType: "image/png" };
        }));
        spies.push(ensure);
        try {
            const director = mountDirector(projectId, node, scene, nodesRef);
            const pending = director.applyDirectorOutput({ scene, shot: scene.shots[0], prompt: "构图", beauty: new Blob(["image"]) });
            await entered.promise;
            nodesRef.current = [{ ...node, metadata: { ...node.metadata, directorSceneId: "other-scene" } }];
            useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current });
            gate.resolve();
            await expect(pending).rejects.toThrow("输出期间项目或镜头已切换、删除，请重试");
            expect(ensure).not.toHaveBeenCalled();
            expect(nodesRef.current.some((item) => item.type === CanvasNodeType.Image)).toBe(false);
        } finally {
            restore();
            useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
        }
    });

    test("A→B→A during output upload abandons before asset persist", async () => {
        const restore = switchScope("owner-a");
        const expected = captureUserScope();
        const scene = createDirectorScene();
        const node = directorNode(scene.id, scene.shots[0].id);
        const nodesRef = { current: [node] };
        const projectId = useCanvasStore.getState().createProject("output aba");
        useCanvasStore.getState().updateProject(projectId, { nodes: [node], directorScenes: [scene] });
        const entered = deferred();
        const gate = deferred();
        const ensure = spyOn(assetSync, "ensureCanvasNodeAsset");
        spies.push(spyOn(App, "useApp").mockReturnValue({ message: { success: () => {}, error: () => {}, warning: () => {} } } as ReturnType<typeof App.useApp>));
        spies.push(spyOn(imageStorage, "uploadImage").mockImplementation(async (_source, _progress, scope) => {
            expect(scope).toEqual(expected);
            entered.resolve();
            await gate.promise;
            return { storageKey: "image:output", url: "blob:output", width: 8, height: 8, bytes: 1, mimeType: "image/png" };
        }));
        spies.push(spyOn(fileStorage, "uploadMediaFile").mockResolvedValue({ storageKey: "file:clay", url: "blob:clay", bytes: 1, mimeType: "video/webm" }));
        spies.push(ensure);
        try {
            const director = mountDirector(projectId, node, scene, nodesRef);
            const pending = director.applyDirectorOutput({ scene, shot: scene.shots[0], prompt: "构图", beauty: new Blob(["image"]), clayVideo: new Blob(["vid"], { type: "video/webm" }) });
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(ensure).not.toHaveBeenCalled();
            expect(fileStorage.uploadMediaFile).toHaveBeenCalledWith(expect.anything(), "director-clay", undefined, expected);
        } finally {
            restore();
            useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
        }
    });

    test("desktop IDB-only apply writes the canvas without claiming a confirmed persist", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const scene = createDirectorScene();
        const node = directorNode(scene.id, scene.shots[0].id);
        const nodesRef = { current: [node] };
        const projectId = useCanvasStore.getState().createProject("output idb");
        useCanvasStore.getState().updateProject(projectId, { nodes: [node], directorScenes: [scene] });
        const urls: string[] = [];
        spies.push(spyOn(App, "useApp").mockReturnValue({ message: { success: () => {}, error: () => {}, warning: () => {} } } as ReturnType<typeof App.useApp>));
        spies.push(spyOn(imageStorage, "uploadImage").mockImplementation(async (_source, _progress, scope) => {
            expect(scope).toEqual(expected);
            return { storageKey: "image:output", url: "blob:output", width: 8, height: 8, bytes: 1, mimeType: "image/png", pendingRemoteUpload: true };
        }));
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return { data: { code: 0, msg: "", data: { asset: { id: "unexpected" } } }, status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                const director = mountDirector(projectId, node, scene, nodesRef);
                const result = await director.applyDirectorOutput({ scene, shot: scene.shots[0], prompt: "构图", beauty: new Blob(["image"]) });
                expect(result).toEqual({ confirmed: false });
                const preview = nodesRef.current.find((item) => item.type === CanvasNodeType.Image);
                expect(preview?.metadata?.storageKey).toBe("image:output");
                expect(preview?.metadata?.assetId).toBeTruthy();
                expect(urls).toEqual([]);
                expect(peekAssetStoreDraft(getActiveUserScope(), preview?.metadata?.assetId || "")?.kind).toBe("upsert");
            });
        } finally {
            restore();
            useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
        }
    });
});
