import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Project = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    revision?: number;
    nodes: Array<{ id: string }>;
    connections: unknown[];
    chatSessions: unknown[];
    activeChatId: null;
    backgroundMode: "grid";
    showImageInfo: boolean;
    viewport: { x: number; y: number; k: number };
    directorScenes: unknown[];
};

const dir = mkdtempSync(join(import.meta.dir, ".local-workspace-stale-"));
const repositorySource = readFileSync(new URL("../src/services/local-workspace-repository.ts", import.meta.url), "utf8");
const storePath = join(dir, "store.ts");
const historyPath = join(dir, "history.ts");
const requestPath = join(dir, "request.ts");
// 画布刷新接缝引入了跨模块依赖；这个用例只关心「陈旧后端不覆盖较新本地内容」，
// 因此把与判据无关的边界替换成最薄替身，而不是让它们把浏览器 API 拉进用例。
const syncStubPath = join(dir, "local-workspace-sync.ts");
const conflictStubPath = join(dir, "canvas-revision-conflict.ts");
const assetStubPath = join(dir, "use-asset-store.ts");
const modeStubPath = join(dir, "workspace-mode.ts");
const resourcesStubPath = join(dir, "api-resources.ts");
const userScopeStubPath = join(dir, "user-scope.ts");
const userScopeGuardStubPath = join(dir, "user-scope-guard.ts");
const canvasContentStubPath = join(dir, "canvas-content.ts");
const rebaseStubPath = join(dir, "canvas-document-rebase.ts");

writeFileSync(storePath, `
export type CanvasProject = any;
export let projects: any[] = [];
export const resetProjects = (next: any[]) => { projects = next; bases.clear(); };
const getState = () => ({
  projects,
  openProject: (id: string) => projects.find((project) => project.id === id) ?? null,
  createProject: () => "unused",
  updateProject: () => {},
  deleteProjects: (ids) => { projects = projects.filter((project) => !ids.includes(project.id)); },
  restoreProject: (project) => { if (!projects.some((item) => item.id === project.id)) projects = [project, ...projects]; },
});
export const useCanvasStore = {
  getState,
  setState: (update: any) => {
    const patch = typeof update === "function" ? update(getState()) : update;
    if (patch.projects) projects = patch.projects;
  },
};
export const flushCanvasStorePersistence = async () => {};
export const applyExternalCanvasRevision = (remote: any, options: any) => {
  const local = projects.find((project: any) => project.id === remote.id);
  if (options?.hasUnsyncedEdits) {
    return { kind: "keep-local", projectId: remote.id, candidate: remote, localRevision: local?.revision ?? 0, remoteRevision: remote.revision ?? 0 };
  }
  const merged = local ? { ...remote, viewport: local.viewport } : remote;
  projects = projects.some((project: any) => project.id === merged.id)
    ? projects.map((project: any) => project.id === merged.id ? merged : project)
    : [...projects, merged];
  options?.onApplied?.(merged, local);
  return { kind: "apply", project: merged, localRevision: local?.revision ?? 0, remoteRevision: merged.revision ?? 0 };
};
export const acceptCanvasExternalRevisionCandidate = () => undefined;
export const clearCanvasExternalRevisionConflict = () => {};
export const canvasDurableSnapshot = () => undefined;
export const canvasExternalRevisionConflict = () => undefined;
export const canvasExternalRevisionVersion = () => 0;
export const subscribeCanvasExternalRevision = () => () => {};
const bases = new Map();
export const recordCanvasDocumentBase = (project) => { bases.set(project.id, { revision: project.revision ?? 0, snapshot: project }); };
export const canvasDocumentBase = (id) => bases.get(id);
export const clearCanvasDocumentBase = (id) => { bases.delete(id); };
`);
writeFileSync(historyPath, "export const useCanvasHistoryStore = { getState: () => ({ recordDeletedProjects: () => {} }) };\n");
writeFileSync(syncStubPath, "export const notifyCanvasRefresh = () => {};\n");
writeFileSync(conflictStubPath, `
export class CanvasBackendSubmitPausedError extends Error { constructor(message = "") { super(message); this.name = "CanvasBackendSubmitPausedError"; } }
export class CanvasStaleScopeError extends Error { constructor(message = "") { super(message); this.name = "CanvasStaleScopeError"; } }
export const isCanvasRevisionConflict = () => false;
export const isCanvasSubmitControlError = (error) => error instanceof CanvasBackendSubmitPausedError || error instanceof CanvasStaleScopeError;
export const canvasBackendSubmitPaused = () => false;
export const pauseCanvasBackendSubmit = () => {};
export const resumeCanvasBackendSubmit = () => {};
export const handleRejectedCanvasBackendSave = async () => false;
export const preserveCanvasConflictDraft = async () => {};
export const setCanvasBackendSaveProgress = () => {};
export const clearCanvasBackendSaveProgress = () => {};
`);
writeFileSync(assetStubPath, "export const useAssetStore = { getState: () => ({ assets: [] }) };\n");
writeFileSync(modeStubPath, "export const isLocalWorkspaceMode = () => true;\n");
writeFileSync(resourcesStubPath, "export const resourceIdFromStorageKey = () => '';\n");
writeFileSync(userScopeStubPath, "export const getActiveUserScope = () => 'guest';\nexport const getActiveUserScopeEpoch = () => 1;\n");
writeFileSync(userScopeGuardStubPath, `
export function captureUserScope(userScope = "guest", epoch = 1) { return { userScope, epoch }; }
export function userScopeMatches() { return true; }
export function assertUserScope() {}
export function isUserScopeAbandonedError() { return false; }
`);
writeFileSync(canvasContentStubPath, `
export const sameCanvasDocument = (left, right) => {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left.nodes || []) === JSON.stringify(right.nodes || []) && left.title === right.title;
};
`);
writeFileSync(rebaseStubPath, `
export const settleInFlightGenerationOverlay = ({ local }) => local;
export const rebaseCanvasDocumentThreeWay = ({ local, remote }) => ({
  project: { ...local, revision: remote.revision, updatedAt: remote.updatedAt, remoteContentHash: remote.remoteContentHash },
  conflict: false,
});
`);
writeFileSync(requestPath, `
export class ApiError extends Error {}
export let remoteProject: any;
export let remoteProjects: any[] = [];
let failurePath = "";
export const setRequestFailure = (path: string) => { failurePath=path; };
export const setRemoteProject = (next: any) => { failurePath=""; remoteProject = next; remoteProjects = next ? [{ id: next.id }] : []; };
export const http = { get: async (path: string) => { if(path===failurePath) throw new Error("read failed"); return path === "/canvas-projects" ? { projects: remoteProjects } : { project: remoteProject }; } };
`);
const operationsPath = join(dir, "operations.ts");
const journalPath = join(dir, "journal.ts");
writeFileSync(operationsPath, "export const commitCanvasDocument = async () => ({ revision: 1, result: {} });\n");
writeFileSync(journalPath, `
const memory = new Map();
const empty = (id) => ({ userScope: "guest", canvasId: id, confirmedRevision: 0, confirmedSnapshot: null, inFlight: null, pendingProjection: null });
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
export const abandonCanvasInFlight = async () => {};
export const clearCanvasOperationJournal = async (id) => { memory.delete(id); };
export const newCanvasCommitOperationId = () => "op";
export const newCanvasProjectionIdentity = () => "proj-test";
export const resetCanvasOperationJournalMemory = () => { memory.clear(); };
`);
writeFileSync(join(dir, "repository.ts"), repositorySource
    .replace('"./canvas-hydration-health"', JSON.stringify(new URL("../src/services/canvas-hydration-health.ts", import.meta.url).href))
    .replace('"@/stores/canvas/use-canvas-store"', JSON.stringify(pathToFileURL(storePath).href))
    .replace('"@/stores/canvas/use-canvas-history-store"', JSON.stringify(pathToFileURL(historyPath).href))
    .replace('"@/services/api/request"', JSON.stringify(pathToFileURL(requestPath).href))
    .replace('"@/services/api/operations"', JSON.stringify(pathToFileURL(operationsPath).href))
    .replace('"@/services/canvas-operation-journal"', JSON.stringify(pathToFileURL(journalPath).href))
    .replace('"@/services/local-workspace-sync"', JSON.stringify(pathToFileURL(syncStubPath).href))
    .replace('"@/services/canvas-revision-conflict"', JSON.stringify(pathToFileURL(conflictStubPath).href))
    .replace('"@/stores/use-asset-store"', JSON.stringify(pathToFileURL(assetStubPath).href))
    .replace('"@/services/workspace-mode"', JSON.stringify(pathToFileURL(modeStubPath).href))
    .replaceAll('"@/lib/user-scope"', JSON.stringify(pathToFileURL(userScopeStubPath).href))
    .replaceAll('"@/lib/user-scope-guard"', JSON.stringify(pathToFileURL(userScopeGuardStubPath).href))
    .replace('"@/lib/canvas/canvas-content"', JSON.stringify(pathToFileURL(canvasContentStubPath).href))
    .replace('"@/lib/canvas/canvas-document-rebase"', JSON.stringify(pathToFileURL(rebaseStubPath).href))
    .replace('"@/services/api/resources"', JSON.stringify(pathToFileURL(resourcesStubPath).href)));

const repository: typeof import("../src/services/local-workspace-repository") = await import(join(dir, "repository.ts"));
const store = await import(storePath);
const request = await import(requestPath);
const journal = await import(journalPath);

const project = (overrides: Partial<Project> = {}): Project => ({
    id: "canvas-a",
    title: "画布 A",
    createdAt: "2026-09-22T08:00:00.000Z",
    updatedAt: "2026-09-22T08:00:00.000Z",
    revision: 0,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: true,
    viewport: { x: 0, y: 0, k: 1 },
    directorScenes: [],
    ...overrides,
});

beforeEach(() => {
    store.resetProjects([]);
    request.setRemoteProject(undefined);
    journal.resetCanvasOperationJournalMemory();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("local workspace stale backend protection", () => {
    it("reports failed list/detail reads and retains cached projects until retry", async () => {
        const health = await import("../src/services/canvas-hydration-health");
        const local = project({nodes:[{id:"keep"}]});
        for (const path of ["/canvas-projects","/canvas-projects/canvas-a"]) {
            store.resetProjects([local]); request.setRemoteProject(project()); request.setRequestFailure(path);
            expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(false);
            expect(store.projects[0]).toEqual(local);
            expect(health.getCanvasHydrationHealth().error).toContain("现有数据已保留");
            expect(health.getCanvasHydrationHealth().loading).toBe(false);
            request.setRequestFailure("");
            await repository.hydrateLocalCanvasProjectsFromBackend();
            expect(health.getCanvasHydrationHealth().error).toBe("");
        }
    });
    it("keeps dirty local drafts when opening a backend snapshot", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 2, nodes: [] });
        store.resetProjects([local]);
        store.recordCanvasDocumentBase(project({ nodes: [] }));
        request.setRemoteProject(remote);

        // The local draft survives and is rebased onto the newer backend revision.
        expect(await repository.openLocalCanvasProjectFromBackend(local.id)).toMatchObject({ nodes: [{ id: "kept-node" }], revision: 2 });
        expect(store.projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("keeps dirty local drafts during backend hydration", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 2, nodes: [] });
        store.resetProjects([local]);
        store.recordCanvasDocumentBase(project({ nodes: [] }));
        request.setRemoteProject(remote);

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(store.projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("clean caches adopt the backend document", async () => {
        const local = project({ updatedAt: "2026-09-22T09:00:00.000Z", nodes: [] });
        const remote = project({ updatedAt: "2026-09-22T08:00:00.000Z", revision: 1, nodes: [{ id: "remote-node" }] });
        store.resetProjects([local]);
        store.recordCanvasDocumentBase(local);
        request.setRemoteProject(remote);

        expect(await repository.openLocalCanvasProjectFromBackend(local.id)).toEqual(remote);
        expect(store.projects[0].nodes).toEqual([{ id: "remote-node" }]);
    });
});
