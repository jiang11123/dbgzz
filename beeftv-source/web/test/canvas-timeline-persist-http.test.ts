import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createDefaultTracks, normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import type { TimelineProject } from "@/types/timeline";

const dir = mkdtempSync(join(import.meta.dir, ".timeline-persist-http-"));
const repositorySource = readFileSync(new URL("../src/services/local-workspace-repository.ts", import.meta.url), "utf8");
const storePath = join(dir, "store.ts");
const historyPath = join(dir, "history.ts");
const requestPath = join(dir, "request.ts");
const assetsPath = join(dir, "assets.ts");
const resourcesPath = join(dir, "resources.ts");
const modePath = join(dir, "mode.ts");
const userScopePath = join(dir, "user-scope.ts");
const userScopeGuardPath = join(dir, "user-scope-guard.ts");

writeFileSync(
    storePath,
    `
export type CanvasProject = any;
export let projects: any[] = [];
export const resetProjects = (next: any[]) => { projects = next; };
const getState = () => ({
  projects,
  openProject: (id: string) => projects.find((project) => project.id === id) ?? null,
  updateProject: (id: string, patch: Record<string, unknown>) => {
    projects = projects.map((project) => project.id === id ? { ...project, ...patch } : project);
  },
  deleteProjects: (ids) => { projects = projects.filter((project) => !ids.includes(project.id)); },
  restoreProject: (project) => { if (!projects.some((item) => item.id === project.id)) projects = [project, ...projects]; },
});
export const useCanvasStore = {
  getState,
  setState: (update) => {
    const patch = typeof update === "function" ? update(getState()) : update;
    if (patch.projects) projects = patch.projects;
  },
};
export let flushCalls = 0;
export let flushImpl = async () => {};
export const setFlushImpl = (next) => { flushImpl = next; };
export const flushCanvasStorePersistence = async () => { flushCalls += 1; return flushImpl(); };
export const resetFlush = () => { flushCalls = 0; flushImpl = async () => {}; };
// 画布刷新接缝：这个用例只关心 timeline 落库，因此把外部 revision 相关入口做成最薄替身。
export const applyExternalCanvasRevision = () => ({ kind: "keep-local", projectId: "", candidate: {}, localRevision: 0, remoteRevision: 0 });
export const acceptCanvasExternalRevisionCandidate = () => undefined;
export const clearCanvasExternalRevisionConflict = () => {};
export const canvasDurableSnapshot = () => undefined;
export const canvasExternalRevisionConflict = () => undefined;
const bases = new Map();
export const recordCanvasDocumentBase = (project) => { bases.set(project.id, { revision: project.revision ?? 0, snapshot: project }); };
export const canvasDocumentBase = (id) => bases.get(id);
export const clearCanvasDocumentBase = (id) => { bases.delete(id); };
`,
);
writeFileSync(historyPath, "export const useCanvasHistoryStore = { getState: () => ({ recordDeletedProjects: () => {} }) };\n");
writeFileSync(
    requestPath,
    `
export class ApiError extends Error {
  status?: number;
  reason?: string;
  retryable: boolean;
  constructor(message: string, options: { status?: number; reason?: string; retryable?: boolean } = {}) {
    super(message);
    this.status = options.status;
    this.reason = options.reason;
    this.retryable = options.retryable ?? false;
  }
}
export let puts: Array<{ path: string; body: any }> = [];
export let putError: Error | null = null;
export let putGuard = null;
export let putGate = Promise.resolve();
export let putStarted = 0;
export const resetPuts = () => { puts = []; putError = null; putGuard = null; putGate = Promise.resolve(); putStarted = 0; };
export const setPutError = (next: Error | null) => { putError = next; };
export const setPutGuard = (next) => { putGuard = next; };
export const setPutGate = (next) => { putGate = next; };
async function write(path, body) {
    putStarted += 1;
    await putGate;
    if (putError) throw putError;
    const project = body?.project ?? body?.params?.document;
    if (putGuard) {
      const guarded = putGuard(path, { project, ...body });
      if (guarded) throw guarded;
    }
    puts.push({ path, body: { ...body, project } });
    return project;
  }
  export const http = {
    put: async (path, body) => {
      const project = await write(path, body);
      return { project: { id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, revision: (project.revision ?? 0) + 1 } };
    },
    post: async (path, body) => {
      const project = await write(path, body);
      const revision = (project.revision ?? 0) + 1;
      return { op: "canvas.document.commit", opId: body.opId, replayed: false, caller: "manual", revision, result: { canvasId: project.id, revision, updatedAt: project.updatedAt } };
    },
  };
`,
);
const operationsPath = join(dir, "operations.ts");
const journalPath = join(dir, "journal.ts");
writeFileSync(
    operationsPath,
    `import { http } from ${JSON.stringify(pathToFileURL(requestPath).href)};
export async function commitCanvasDocument(input) {
  return http.post("/ops/canvas.document.commit", {
    opId: input.operationId,
    params: { canvasId: input.canvasId, expectedRevision: input.expectedRevision, document: input.document },
  });
}
`,
);
writeFileSync(
    journalPath,
    `
const memory = new Map();
const empty = (canvasId) => ({ userScope: "guest", canvasId, confirmedRevision: 0, confirmedSnapshot: null, inFlight: null, pendingProjection: null });
export class CanvasJournalError extends Error { constructor(message) { super(message); this.name = "CanvasJournalError"; } }
export const peekCanvasOperationJournal = (id) => memory.get(id);
export const loadCanvasOperationJournal = async (id) => memory.get(id) ?? empty(id);
export const saveCanvasOperationJournal = async (journal) => { memory.set(journal.canvasId, journal); };
export const updateCanvasOperationJournal = async (id, _scope, updater) => {
  const current = memory.get(id) ?? empty(id);
  const next = await updater(current);
  if (next == null) return current;
  memory.set(id, next);
  return next;
};
export const recordConfirmedCanvasCommit = async (project, _scope, options) => {
  return updateCanvasOperationJournal(project.id, "guest", (current) => {
    const incoming = project.revision ?? current.confirmedRevision;
    const ackMatches = options?.ackOperationId && current.inFlight?.operationId === options.ackOperationId;
    const recoveryBase = current.pendingProjection?.base ?? current.confirmedSnapshot;
    return {
      ...current,
      confirmedRevision: Math.max(current.confirmedRevision, incoming),
      confirmedSnapshot: incoming < current.confirmedRevision ? current.confirmedSnapshot : project,
      inFlight: ackMatches ? null : current.inFlight,
      pendingProjection: options?.unflushedProjection && recoveryBase
        ? { identity: "proj-test", revision: incoming, base: recoveryBase, remote: project }
        : current.pendingProjection,
    };
  });
};
export const clearCanvasPendingProjection = async (id, _scope, identity) => {
  return updateCanvasOperationJournal(id, "guest", (current) => {
    if (current.pendingProjection?.identity !== identity) return;
    return { ...current, pendingProjection: null };
  });
};
export const abandonCanvasInFlight = async (id) => {
  const current = memory.get(id) ?? empty(id);
  memory.set(id, { ...current, inFlight: null });
};
export const clearCanvasOperationJournal = async (id) => { memory.delete(id); };
export const newCanvasCommitOperationId = () => "canvas-commit-test";
export const newCanvasProjectionIdentity = () => "proj-test";
export const resetCanvasOperationJournalMemory = () => { memory.clear(); };
`,
);
writeFileSync(assetsPath, "export const useAssetStore = { getState: () => ({ assets: [] }) };\n");
writeFileSync(resourcesPath, 'export const resourceIdFromStorageKey = () => "";\n');
writeFileSync(modePath, "export let localMode = true; export const setLocalMode = (next: boolean) => { localMode = next; }; export const isLocalWorkspaceMode = () => localMode;\n");
writeFileSync(userScopePath, "export const getActiveUserScope = () => 'guest';\nexport const getActiveUserScopeEpoch = () => 1;\n");
writeFileSync(userScopeGuardPath, `
export function captureUserScope(userScope = "guest", epoch = 1) { return { userScope, epoch }; }
export function userScopeMatches() { return true; }
export function assertUserScope() {}
export function isUserScopeAbandonedError() { return false; }
`);
const rebasePath = join(dir, "canvas-document-rebase.ts");
writeFileSync(rebasePath, `
export const settleInFlightGenerationOverlay = ({ local }) => local;
export const rebaseCanvasDocumentThreeWay = ({ local, remote }) => ({
  project: { ...local, revision: remote.revision, updatedAt: remote.updatedAt, remoteContentHash: remote.remoteContentHash },
  conflict: false,
});
`);
writeFileSync(
    join(dir, "repository.ts"),
    repositorySource
        .replace('"./canvas-hydration-health"', JSON.stringify(new URL("../src/services/canvas-hydration-health.ts", import.meta.url).href))
        .replace('"@/stores/canvas/use-canvas-store"', JSON.stringify(pathToFileURL(storePath).href))
        .replace('"@/stores/canvas/use-canvas-history-store"', JSON.stringify(pathToFileURL(historyPath).href))
        .replace('"@/services/api/request"', JSON.stringify(pathToFileURL(requestPath).href))
        .replace('"@/services/api/operations"', JSON.stringify(pathToFileURL(operationsPath).href))
        .replace('"@/services/canvas-operation-journal"', JSON.stringify(pathToFileURL(journalPath).href))
        .replace('"@/services/api/resources"', JSON.stringify(pathToFileURL(resourcesPath).href))
        .replace('"@/stores/use-asset-store"', JSON.stringify(pathToFileURL(assetsPath).href))
        .replace('"@/services/workspace-mode"', JSON.stringify(pathToFileURL(modePath).href))
        .replaceAll('"@/lib/user-scope"', JSON.stringify(pathToFileURL(userScopePath).href))
        .replaceAll('"@/lib/user-scope-guard"', JSON.stringify(pathToFileURL(userScopeGuardPath).href))
        .replace('"@/lib/canvas/canvas-document-rebase"', JSON.stringify(pathToFileURL(rebasePath).href)),
);

const repository: typeof import("../src/services/local-workspace-repository") = await import(join(dir, "repository.ts"));
const store = await import(storePath);
const request = await import(requestPath);
const mode = await import(modePath);
const journal = await import(journalPath);

const timeline: TimelineProject = normalizeTimelineProject({
    version: 2,
    tracks: createDefaultTracks(),
    durationMs: 5600,
    clips: [
        {
            id: "clip-audio-1",
            kind: "audio",
            nodeId: "7vvfM674HnenwTekmj88V",
            trackId: "audio-1",
            startMs: 0,
            durationMs: 5600,
            title: "旁白",
        },
    ],
});

const project = {
    id: "canvas-a",
    title: "验收画布",
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    revision: 1,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
    directorScenes: [],
};

beforeEach(() => {
    store.resetProjects([{ ...project }]);
    request.resetPuts();
    store.resetFlush();
    mode.setLocalMode(true);
    journal.resetCanvasOperationJournalMemory();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("persistCanvasTimeline http", () => {
    it("PUTs the timeline document to the desktop canvas route", async () => {
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].path).toBe("/ops/canvas.document.commit");
        expect(request.puts[0].body.project.timeline.durationMs).toBe(5600);
        expect(request.puts[0].body.project.timeline.clips).toEqual([expect.objectContaining({ id: "clip-audio-1", kind: "audio", nodeId: "7vvfM674HnenwTekmj88V", durationMs: 5600 })]);
        expect(request.puts[0].body.project.timeline.tracks.map((track: { kind: string }) => track.kind)).toEqual(["video", "audio", "subtitle"]);
    });

    it("does not PUT on the hosted profile", async () => {
        mode.setLocalMode(false);
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(request.puts).toEqual([]);
        expect(store.projects[0].timeline.durationMs).toBe(5600);
    });

    it("local PUT is not blocked by a pending or rejected IndexedDB flush", async () => {
        store.setFlushImpl(() => new Promise(() => {}));
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].body.project.timeline.durationMs).toBe(5600);
        expect(store.flushCalls).toBe(1);

        request.resetPuts();
        store.resetFlush();
        journal.resetCanvasOperationJournalMemory();
        store.resetProjects([{ ...project }]);
        store.setFlushImpl(async () => {
            throw new Error("IndexedDB hung");
        });
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].body.project.timeline.clips[0].nodeId).toBe("7vvfM674HnenwTekmj88V");
    });

    it("hosted profile still awaits flush and does not PUT", async () => {
        mode.setLocalMode(false);
        store.setFlushImpl(async () => {
            throw new Error("IndexedDB hung");
        });
        let caught: unknown;
        try {
            await repository.persistCanvasTimeline(project.id, timeline);
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("IndexedDB hung");
        expect(request.puts).toEqual([]);
        expect(store.flushCalls).toBe(1);

        store.resetFlush();
        store.resetProjects([{ ...project }]);
        let resolveFlush: () => void = () => undefined;
        store.setFlushImpl(
            () =>
                new Promise<void>((resolve) => {
                    resolveFlush = resolve;
                }),
        );
        let settled = false;
        const pending = repository.persistCanvasTimeline(project.id, timeline).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(request.puts).toEqual([]);
        expect(store.flushCalls).toBe(1);
        resolveFlush();
        await pending;
        expect(settled).toBe(true);
        expect(request.puts).toEqual([]);
    });

    it("rejects when the desktop PUT fails", async () => {
        request.setPutError(new request.ApiError("画布后端持久化失败", { status: 400 }));
        let caught: unknown;
        try {
            await repository.persistCanvasTimeline(project.id, timeline);
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("画布后端持久化失败");
        expect(request.puts).toEqual([]);
        expect(store.projects[0].timeline).toBeUndefined();
    });
});

const originalAudioNode = {
    id: "audio-original",
    type: "audio",
    title: "旁白",
    position: { x: 0, y: 0 },
    width: 320,
    height: 120,
    metadata: { storageKey: "resource:audio-owned", content: "http://127.0.0.1:3184/api/resources/audio-owned/file" },
};
const historyAudioNode = {
    id: "audio-history",
    type: "audio",
    title: "历史音频",
    position: { x: 360, y: 0 },
    width: 320,
    height: 120,
    metadata: { storageKey: "resource:audio-owned", content: "http://127.0.0.1:3184/api/resources/audio-owned/file" },
};

describe("persistCanvasDocument http", () => {
    it("PUTs history nodes to the desktop canvas route before returning", async () => {
        store.resetProjects([{ ...project, timeline, nodes: [originalAudioNode] }]);
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].path).toBe("/ops/canvas.document.commit");
        expect(request.puts[0].body.project.nodes.map((node: { title: string }) => node.title)).toEqual(["旁白", "历史音频"]);
        expect(request.puts[0].body.project.nodes[1].metadata.storageKey).toBe("resource:audio-owned");
        expect(request.puts[0].body.project.timeline.durationMs).toBe(5600);
        expect(request.puts[0].body.project.timeline.clips[0].nodeId).toBe("7vvfM674HnenwTekmj88V");
    });

    it("does not PUT on the hosted profile", async () => {
        mode.setLocalMode(false);
        store.resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(request.puts).toEqual([]);
        expect(store.projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白", "历史音频"]);
    });

    it("local PUT is not blocked by a pending or rejected IndexedDB flush", async () => {
        store.resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        store.setFlushImpl(() => new Promise(() => {}));
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].body.project.nodes).toHaveLength(2);
        expect(store.flushCalls).toBe(1);

        request.resetPuts();
        store.resetFlush();
        journal.resetCanvasOperationJournalMemory();
        store.resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        store.setFlushImpl(async () => {
            throw new Error("IndexedDB hung");
        });
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].body.project.nodes[1].title).toBe("历史音频");
    });

    it("hosted profile still awaits flush and does not PUT", async () => {
        mode.setLocalMode(false);
        store.resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        store.setFlushImpl(async () => {
            throw new Error("IndexedDB hung");
        });
        let caught: unknown;
        try {
            await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("IndexedDB hung");
        expect(request.puts).toEqual([]);
        expect(store.flushCalls).toBe(1);
        expect(store.projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白"]);
    });

    it("rejects when the desktop PUT fails", async () => {
        store.resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        request.setPutError(new request.ApiError("画布保存失败，请重试", { status: 400 }));
        let caught: unknown;
        try {
            await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("画布保存失败，请重试");
        expect(request.puts).toEqual([]);
        expect(store.projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白"]);
    });

    it("desktop PUT that inspects canvas media rejects unbound history nodes and rolls back", async () => {
        request.setPutGuard((_path: string, body: { project?: { nodes?: Array<{ metadata?: { assetId?: string; storageKey?: string } }> } }) => {
            for (const node of body.project?.nodes || []) {
                const storageKey = String(node.metadata?.storageKey || "");
                if (storageKey.startsWith("resource:") && !node.metadata?.assetId) {
                    return new request.ApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
                }
            }
            return null;
        });
        const original = { ...originalAudioNode, metadata: { ...originalAudioNode.metadata, assetId: "asset-owned" } };
        store.resetProjects([{ ...project, nodes: [original] }]);
        let caught: unknown;
        try {
            await repository.persistCanvasDocument(project.id, { nodes: [original, historyAudioNode] });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toContain("尚未进入素材库");
        expect(request.puts).toEqual([]);
        expect(
            store.projects[0].nodes.map((node: { title: string; metadata?: { assetId?: string } }) => ({
                title: node.title,
                assetId: node.metadata?.assetId || "",
            })),
        ).toEqual([{ title: "旁白", assetId: "asset-owned" }]);
    });

    it("desktop PUT that inspects canvas media accepts history nodes that reuse the owned assetId", async () => {
        request.setPutGuard((_path: string, body: { project?: { nodes?: Array<{ metadata?: { assetId?: string; storageKey?: string } }> } }) => {
            for (const node of body.project?.nodes || []) {
                const storageKey = String(node.metadata?.storageKey || "");
                if (storageKey.startsWith("resource:") && !node.metadata?.assetId) {
                    return new request.ApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
                }
            }
            return null;
        });
        const original = { ...originalAudioNode, metadata: { ...originalAudioNode.metadata, assetId: "asset-owned" } };
        const history = { ...historyAudioNode, metadata: { ...historyAudioNode.metadata, assetId: "asset-owned" } };
        store.resetProjects([{ ...project, nodes: [original] }]);
        await repository.persistCanvasDocument(project.id, { nodes: [original, history] });
        expect(request.puts).toHaveLength(1);
        expect(request.puts[0].path).toBe("/ops/canvas.document.commit");
        expect(request.puts[0].body.assets).toBeUndefined();
        expect(
            request.puts[0].body.project.nodes.map((node: { title: string; metadata?: { assetId?: string } }) => ({
                title: node.title,
                assetId: node.metadata?.assetId,
            })),
        ).toEqual([
            { title: "旁白", assetId: "asset-owned" },
            { title: "历史音频", assetId: "asset-owned" },
        ]);
    });

    it("deferred PUT rejection keeps intervening unrelated edits and drops the optimistic nodes patch", async () => {
        let rejectPut: (error: Error) => void = () => undefined;
        request.setPutGate(
            new Promise<void>((_resolve, reject) => {
                rejectPut = reject;
            }),
        );
        store.resetProjects([{ ...project, nodes: [originalAudioNode], revision: 4 }]);
        const pending = repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        for (let attempt = 0; attempt < 20 && request.putStarted === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(request.putStarted).toBe(1);
        store.useCanvasStore.getState().updateProject(project.id, { title: "改名后的画布" });
        store.useCanvasStore.setState((state: { projects: Array<Record<string, unknown>> }) => ({
            projects: state.projects.map((item) => (item.id === project.id ? { ...item, revision: 9 } : item)),
        }));
        rejectPut(new request.ApiError("画布保存失败，请重试", { status: 400 }));
        let caught: unknown;
        try {
            await pending;
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("画布保存失败，请重试");
        expect(request.puts).toEqual([]);
        expect(store.projects[0].title).toBe("改名后的画布");
        expect(store.projects[0].revision).toBe(9);
        expect(store.projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白"]);
    });

    it("deferred PUT rejection keeps in-flight node edits that are not the optimistic insert", async () => {
        let rejectPut: (error: Error) => void = () => undefined;
        request.setPutGate(
            new Promise<void>((_resolve, reject) => {
                rejectPut = reject;
            }),
        );
        store.resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        const pending = repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        for (let attempt = 0; attempt < 20 && request.putStarted === 0; attempt += 1) {
            await Promise.resolve();
        }
        const editedOriginal = { ...originalAudioNode, title: "旁白改名" };
        const laterText = {
            id: "text-later",
            type: "text",
            title: "备注",
            position: { x: 720, y: 0 },
            width: 240,
            height: 120,
            metadata: { content: "飞行中编辑" },
        };
        store.useCanvasStore.getState().updateProject(project.id, { nodes: [editedOriginal, historyAudioNode, laterText] });
        rejectPut(new request.ApiError("画布保存失败，请重试", { status: 400 }));
        await pending.catch(() => undefined);
        expect(store.projects[0].nodes.map((node: { id: string; title: string }) => ({ id: node.id, title: node.title }))).toEqual([
            { id: "audio-original", title: "旁白改名" },
            { id: "text-later", title: "备注" },
        ]);
    });
});
