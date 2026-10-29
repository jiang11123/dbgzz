import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


// Bun has no IndexedDB. Only the optional browser cache is emulated here;
// all canonical requests go to the actual isolated SQLite server below.
const browserCaches = new Map<string, Map<string, unknown>>();
const originalWindow = globalThis.window;
function cacheInstance(namespace = "app_state") {
    let data = browserCaches.get(namespace);
    if (!data) browserCaches.set(namespace, data = new Map());
    return {
        config: () => undefined,
        ready: async () => undefined,
        createInstance: (options: { storeName?: string }) => cacheInstance(options.storeName),
        getItem: async (key: string) => data!.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { data!.set(key, value); return value; },
        removeItem: async (key: string) => { data!.delete(key); },
        clear: async () => { data!.clear(); },
        keys: async () => [...data!.keys()],
        length: async () => data!.size,
        iterate: async (callback: (value: unknown, key: string, index: number) => unknown) => {
            let index = 0;
            for (const [key, value] of data!) {
                const result = callback(value, key, ++index);
                if (result !== undefined) return result;
            }
        },
    };
}
mock.module("localforage", () => ({ default: cacheInstance() }));
const { restoreCanvasArchive, assertRestoredCanvasMatches } = await import("@/lib/canvas/canvas-archive-restore");
const { openCanvasArchive } = await import("@/lib/canvas/canvas-export");
const { createZip } = await import("@/lib/zip");
const { apiClient, configureApiRuntime, http } = await import("@/services/api/request");
const { resetCanvasOperationJournalMemory } = await import("@/services/canvas-operation-journal");
const { syncLocalCanvasProjectToBackend, readLocalCanvasProjectFromBackend } = await import("@/services/local-workspace-repository");
const { useAssetStore } = await import("@/stores/use-asset-store");
const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");

const backendDir = resolve(import.meta.dir, "../../backend");
const serverBin = join(tmpdir(), `beeftv-archive-restore-server-${process.pid}`);
const videoBytes = new Uint8Array([9, 8, 7, 6]);
const audioBytes = new Uint8Array([5, 4, 3, 2, 1]);
const drawingPreviewBytes = new Uint8Array([11, 12, 13, 14, 15]);
const folderCoverBytes = new Uint8Array([16, 17, 18, 19]);
let built = false;

type RunningServer = {
    dataDir: string;
    port: number;
    process: Subprocess;
};

function resetStores() {
    useCanvasStore.setState({ projects: [], folders: [], hydrated: true });
    useAssetStore.setState({ assets: [], hydrated: true });
    resetCanvasOperationJournalMemory();
}

async function buildServer() {
    if (built) return;
    const build = spawn(["go", "build", "-o", serverBin, "./cmd/server"], {
        cwd: backendDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CGO_ENABLED: "1" },
    });
    const code = await build.exited;
    if (code !== 0) {
        const err = await new Response(build.stderr).text();
        throw new Error(`go build failed: ${err}`);
    }
    built = true;
}

async function waitReady(port: number, process: Subprocess) {
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
        if (process.exitCode != null) {
            const err = process.stderr ? await new Response(process.stderr).text() : "";
            throw new Error(`backend exited ${process.exitCode}: ${err || last}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
            last = await response.text();
            if (response.ok && last.includes('"code":0')) return;
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        await Bun.sleep(200);
    }
    throw new Error(`backend not ready: ${last}`);
}

function freePort() {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("ok"); } });
    const port = probe.port;
    probe.stop(true);
    return port;
}

async function startServer(dataDir: string): Promise<RunningServer> {
    await buildServer();
    const port = freePort();
    const child = spawn([serverBin], {
        cwd: backendDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            CANVAS_BACKEND_DATA_DIR: dataDir,
            CANVAS_BACKEND_ADDR: `127.0.0.1:${port}`,
            CANVAS_AUTO_MIGRATE: "true",
            CANVAS_DATABASE_DRIVER: "sqlite",
            CANVAS_CORS_ORIGINS: "*",
        },
    });
    await waitReady(port, child);
    return { dataDir, port, process: child };
}

async function stopServer(server: RunningServer | undefined) {
    if (!server) return;
    server.process.kill();
    await Promise.race([server.process.exited, Bun.sleep(5_000)]);
}

function connect(port: number) {
    configureApiRuntime(`http://127.0.0.1:${port}/api`, "");
    apiClient.defaults.timeout = 20_000;
}

async function listProjects() {
    const data = await http.get<{ projects: Array<{ id: string }> }>("/canvas-projects");
    return data.projects || [];
}

async function readProject(id: string) {
    const data = await http.get<{ project: {
        id: string;
        workspaceProjectId?: string;
        folderId?: string;
        revision?: number;
        nodes: Array<{ type?: string; metadata?: { storageKey?: string; prompt?: string; assetId?: string; drawingId?: string } }>;
        timeline?: { clips: Array<{ directMedia?: { storageKey?: string; assetId?: string } }> };
    } }>(`/canvas-projects/${encodeURIComponent(id)}`);
    return data.project;
}

async function listFolders() {
    const data = await http.get<{ folders: Array<{ id: string; name: string; coverResourceId?: string }> }>("/canvas-folders");
    return data.folders || [];
}

async function readDrawing(canvasId: string, drawingId: string) {
    const data = await http.get<{ drawing: {
        drawingId: string;
        revision: number;
        snapshot?: { elements?: Array<{ id?: string }> };
        previewResourceId?: string;
    } }>(`/canvas-projects/${encodeURIComponent(canvasId)}/drawings/${encodeURIComponent(drawingId)}`);
    return data.drawing;
}

async function readResourceBytes(resourceId: string) {
    const response = await apiClient.get<ArrayBuffer>(`/resources/${encodeURIComponent(resourceId)}/file?proxy=1`, { responseType: "arraybuffer" });
    return new Uint8Array(response.data);
}

function resourceId(storageKey?: string) {
    return storageKey?.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
}

async function fixtureZip() {
    return createZip([
        {
            name: "projects.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 4,
                exportedAt: "2026-10-02T00:00:00.000Z",
                folders: [{ id: "folder-old", name: "剧集", coverPath: "folders/old/cover.png", coverMimeType: "image/png", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
                projects: [{
                    project: {
                        id: "old-canvas",
                        workspaceProjectId: "old-workspace",
                        folderId: "folder-old",
                        title: "持久画布",
                        revision: 0,
                        viewport: { x: -17.6638, y: 280.4097, k: 0.3847 },
                        nodes: [{
                            id: "n-video",
                            type: "video",
                            title: "镜头",
                            position: { x: 0, y: 0 },
                            width: 320,
                            height: 180,
                            metadata: {
                                storageKey: "video:clip",
                                content: "blob:expired",
                                prompt: "描述里提到 data:image/png 和 blob:expired，但不是媒体文件",
                            },
                        }, {
                            id: "n-drawing",
                            type: "drawing",
                            title: "分镜手稿",
                            position: { x: 40, y: 0 },
                            width: 240,
                            height: 240,
                            metadata: { drawingId: "sketch" },
                        }],
                        connections: [{ id: "video-drawing", source: "n-video", target: "n-drawing" }],
                        timeline: {
                            version: 2,
                            durationMs: 1000,
                            tracks: [{ id: "voice", kind: "audio", label: "配音", order: 0 }],
                            clips: [{
                                id: "c1",
                                kind: "audio",
                                nodeId: "n-video",
                                trackId: "voice",
                                startMs: 0,
                                durationMs: 1000,
                                directMedia: { id: "m1", kind: "audio", title: "配音", storageKey: "audio:voice", url: "blob:expired" },
                            }],
                        },
                    },
                    files: [
                        { storageKey: "video:clip", path: "projects/old-canvas/files/clip.mp4", mimeType: "video/mp4", bytes: videoBytes.byteLength },
                        { storageKey: "audio:voice", path: "projects/old-canvas/files/voice.wav", mimeType: "audio/wav", bytes: audioBytes.byteLength },
                    ],
                    drawingDocuments: [{
                        drawingId: "sketch",
                        version: 2,
                        engine: "excalidraw",
                        snapshot: { elements: [{ id: "shape-1" }] },
                        revision: 2,
                        updatedAt: "2026-10-02T00:00:00.000Z",
                        shapeCount: 1,
                        pageCount: 1,
                        previewPath: "projects/old-canvas/drawings/sketch.png",
                    }],
                }],
            }),
        },
        { name: "projects/old-canvas/files/clip.mp4", data: videoBytes },
        { name: "projects/old-canvas/files/voice.wav", data: audioBytes },
        { name: "projects/old-canvas/drawings/sketch.png", data: drawingPreviewBytes },
        { name: "folders/old/cover.png", data: folderCoverBytes },
    ]);
}

beforeEach(() => {
    globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } as unknown as Window & typeof globalThis;
});
afterEach(() => {
    configureApiRuntime("/api", "");
    resetStores();
    globalThis.window = originalWindow;
});

afterAll(() => {
    rmSync(serverBin, { force: true });
});

test("valid archive restores into isolated SQLite, survives backend restart, and keeps media bytes plus timeline", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "beeftv-archive-sqlite-"));
    let server: RunningServer | undefined;
    try {
        server = await startServer(dataDir);
        connect(server.port);
        resetStores();
        const zip = await fixtureZip();
        const result = await restoreCanvasArchive(zip);
        expect(result.storage).toBe("backend");
        expect(result.count).toBe(1);
        expect(useCanvasStore.getState().openProject(result.projectIds[0])?.viewport).toEqual({ x: -17.6638, y: 280.4097, k: 0.3847 });
        expect(result.projectIds[0]).not.toBe("old-canvas");
        const listed = await listProjects();
        expect(listed.map((item) => item.id)).toEqual(result.projectIds);
        const saved = await readProject(result.projectIds[0]);
        expect(saved.id).toBe(result.projectIds[0]);
        expect(saved.workspaceProjectId).not.toBe("old-workspace");
        expect((saved.revision ?? 0) >= 1).toBe(true);
        const folders = await listFolders();
        expect(folders).toHaveLength(1);
        expect(folders[0].id).not.toBe("folder-old");
        expect(folders[0].name).toBe("剧集");
        expect(folders[0].coverResourceId).toBeTruthy();
        expect(await readResourceBytes(folders[0].coverResourceId!)).toEqual(folderCoverBytes);
        expect(saved.folderId).toBe(folders[0].id);
        expect(result.folderIds).toEqual([folders[0].id]);
        expect(saved.nodes[0].metadata?.storageKey).toStartWith("resource:");
        expect(saved.nodes[0].metadata?.prompt).toContain("data:image/png");
        expect(saved.nodes[0].metadata?.assetId).toBeTruthy();
        expect(saved.nodes[1].metadata?.drawingId).toBe("sketch");
        const drawing = await readDrawing(saved.id, "sketch");
        expect(drawing.drawingId).toBe("sketch");
        expect(drawing.revision).toBeGreaterThanOrEqual(1);
        expect(drawing.snapshot?.elements?.[0]?.id).toBe("shape-1");
        expect(drawing.previewResourceId).toBeTruthy();
        const clipKey = saved.timeline?.clips[0].directMedia?.storageKey;
        expect(clipKey).toStartWith("resource:");
        const videoId = resourceId(saved.nodes[0].metadata?.storageKey);
        const audioId = resourceId(clipKey);
        // Fixture bytes prove the same octets were stored; they are not a playable video file.
        expect(await readResourceBytes(videoId)).toEqual(videoBytes);
        expect(await readResourceBytes(audioId)).toEqual(audioBytes);
        expect(await readResourceBytes(drawing.previewResourceId!)).toEqual(drawingPreviewBytes);

        await stopServer(server);
        for (const cache of browserCaches.values()) cache.clear();
        server = await startServer(dataDir);
        connect(server.port);
        resetStores();
        const restartedFolders = await listFolders();
        expect(await readResourceBytes(restartedFolders[0].coverResourceId!)).toEqual(folderCoverBytes);
        expect(restartedFolders.map((folder) => ({ id: folder.id, name: folder.name }))).toEqual(folders.map((folder) => ({ id: folder.id, name: folder.name })));
        const restarted = await readProject(result.projectIds[0]);
        expect(restarted.folderId).toBe(saved.folderId);
        expect(restarted.nodes[0].metadata?.storageKey).toBe(saved.nodes[0].metadata?.storageKey);
        expect(restarted.timeline?.clips[0].directMedia?.storageKey).toBe(clipKey);
        const restartedDrawing = await readDrawing(saved.id, "sketch");
        expect(restartedDrawing.drawingId).toBe("sketch");
        expect(restartedDrawing.revision).toBe(drawing.revision);
        expect(restartedDrawing.snapshot?.elements?.[0]?.id).toBe("shape-1");
        expect(restartedDrawing.previewResourceId).toBe(drawing.previewResourceId);
        expect(await readResourceBytes(videoId)).toEqual(videoBytes);
        expect(await readResourceBytes(audioId)).toEqual(audioBytes);
        expect(await readResourceBytes(restartedDrawing.previewResourceId!)).toEqual(drawingPreviewBytes);

        const retry = await restoreCanvasArchive(zip);
        expect(retry.projectIds[0]).not.toBe(result.projectIds[0]);
        expect(retry.projectIds[0]).not.toBe("old-canvas");
        const afterRetry = await listProjects();
        expect(afterRetry.map((item) => item.id).sort()).toEqual([...result.projectIds, ...retry.projectIds].sort());
        const retried = await readProject(retry.projectIds[0]);
        expect(retried.id).not.toBe("old-canvas");
        expect(retried.workspaceProjectId).not.toBe("old-workspace");
        expect(retried.workspaceProjectId).not.toBe(saved.workspaceProjectId);
        expect(retried.nodes[0].metadata?.storageKey).toStartWith("resource:");
    } finally {
        await stopServer(server);
        rmSync(dataDir, { recursive: true, force: true });
    }
}, 180_000);

test("canonical readback still rejects lost nodes, connections, or title and rolls back SQLite restore", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "beeftv-archive-sqlite-content-"));
    let server: RunningServer | undefined;
    try {
        server = await startServer(dataDir);
        connect(server.port);
        resetStores();
        const zip = await fixtureZip();
        for (const patch of [{ nodes: [] }, { connections: [] }, { title: "" }]) {
            await expect(restoreCanvasArchive(zip, {
                persistProject: async (id) => {
                    const live = useCanvasStore.getState().openProject(id)!;
                    await syncLocalCanvasProjectToBackend(id);
                    const saved = await readLocalCanvasProjectFromBackend(id);
                    assertRestoredCanvasMatches(live, { ...saved, ...patch }, "backend");
                },
            })).rejects.toThrow();
            expect(await listProjects()).toEqual([]);
            expect(useCanvasStore.getState().projects).toEqual([]);
            expect((await http.get<{ assets: unknown[] }>("/assets")).assets).toEqual([]);
        }
    } finally {
        await stopServer(server);
        rmSync(dataDir, { recursive: true, force: true });
    }
}, 180_000);

test("missing archive entry and persist failure do not create a saved SQLite canvas", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "beeftv-archive-sqlite-neg-"));
    let server: RunningServer | undefined;
    try {
        server = await startServer(dataDir);
        connect(server.port);
        resetStores();
        const missing = await createZip([{
            name: "projects.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 4,
                projects: [{
                    project: {
                        id: "broken",
                        title: "损坏画布",
                        nodes: [{ id: "n1", type: "video", title: "镜头", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: "video:missing" } }],
                        connections: [],
                    },
                    files: [{ storageKey: "video:missing", path: "projects/broken/files/missing.mp4", mimeType: "video/mp4", bytes: 3 }],
                }],
            }),
        }]);
        await expect(openCanvasArchive(missing)).rejects.toThrow("missing.mp4");
        await expect(restoreCanvasArchive(missing)).rejects.toThrow("missing.mp4");
        expect(await listProjects()).toEqual([]);
        expect(useCanvasStore.getState().projects).toEqual([]);

        const zip = await fixtureZip();
        const failure = await restoreCanvasArchive(zip, {
            persistProject: async (id) => {
                await syncLocalCanvasProjectToBackend(id);
                throw new Error("画布未保存到工作区");
            },
        }).catch((error: unknown) => error);
        expect(failure).not.toBeInstanceOf(AggregateError);
        expect((failure as Error).message).toBe("画布未保存到工作区");
        expect(useCanvasStore.getState().projects).toEqual([]);
        expect(await listProjects()).toEqual([]);
        const assets = await http.get<{ assets: unknown[] }>("/assets");
        expect(assets.assets).toEqual([]);
    } finally {
        await stopServer(server);
        rmSync(dataDir, { recursive: true, force: true });
    }
}, 180_000);
