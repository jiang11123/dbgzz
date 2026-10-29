import { mergeCanvasRefreshPatch } from "@/lib/canvas/canvas-patch-merge";
import { rebaseCanvasDocumentThreeWay } from "@/lib/canvas/canvas-document-rebase";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { App } from "antd";
import { useNavigate } from "react-router";

import { canvasAppearanceForTheme, DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { normalizeCanvasNodeTimestamps } from "@/lib/canvas/canvas-node-timestamps";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { normalizeWorkflowContainers } from "@/lib/canvas/reusable-workflow-instance";
import { migrateDirectorCanvas } from "@/lib/canvas/director/director-node-migration";
import { canvasWorkspaceProjectId, listCanvasWorkspaceProjectCanvases } from "@/lib/canvas/canvas-workspace-project";
import { carryGenerationRecoveryRestore, hydrateAssistantImages, resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { forceOverwriteRemoteCanvasSync, hasRemoteUserDataSyncSession, loadCanvasProjectForEditing, saveRemoteUserDataNow, subscribeCanvasRefresh } from "@/services/local-workspace-sync";
import { createWorkspaceCanvasProject, deleteWorkspaceCanvasProjects } from "@/services/workspace-project-repository";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { hasUnconfirmedCanvasEdits, holdExternalCanvasRevisionForEditor, scheduleLocalCanvasBackendSync, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { isCanvasSubmitControlError } from "@/services/canvas-revision-conflict";
import { assertUserScope, captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import { projectSyncProgress, useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { readCanvasSyncDrafts } from "@/services/canvas-sync-drafts";
import { useUserStore } from "@/stores/use-user-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { CanvasHistorySnapshot } from "./use-canvas-history";

function isExpectedLocalOnlySyncError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /尚未建立云端同步会话|未登录|guest/i.test(message);
}

type EditorDocument = Pick<CanvasHistorySnapshot, "nodes" | "connections" | "chatSessions" | "activeChatId">;

function editorDocumentOf(source: { nodes: CanvasNodeData[]; connections: CanvasConnection[]; chatSessions?: CanvasAssistantSession[]; activeChatId?: string | null }): EditorDocument {
    return { nodes: source.nodes, connections: source.connections, chatSessions: source.chatSessions || [], activeChatId: source.activeChatId ?? null };
}

/** 普通打开画布时对节点做的恢复与规范化：中断的上传和生成、最小尺寸、导演迁移、时间戳、媒体语义。 */
function openCanvasNodes(project: CanvasProject) {
    const sourceNodes = resetInterruptedGeneration(project.nodes);
    const sourceScenes = project.directorScenes || [];
    const directorMigration = migrateDirectorCanvas(sourceNodes, sourceScenes);
    const migratedNodes = normalizeWorkflowContainers(directorMigration.nodes);
    const migration = { ...directorMigration, nodes: migratedNodes };
    const hasNodeMigration = directorMigration.nodes.some((node, index) => node !== sourceNodes[index])
        || migratedNodes.some((node, index) => node !== directorMigration.nodes[index])
        || migration.directorScenes !== sourceScenes;
    const nodes = normalizeCanvasMediaNodeSemanticsList(normalizeCanvasNodeTimestamps(migratedNodes, {
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
    }));
    return { nodes, migration, hasNodeMigration };
}

function sameValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length && keys.every((key) => sameValue(leftRecord[key], rightRecord[key]));
}

/**
 * 三路合并用的“合并前”节点。别处改了什么，按存储里的原始内容（base→incoming）判断；
 * 本地改了什么，按编辑器自己看到的那份（observed，含打开时的恢复与规范化）判断。
 * 某个字段别处没改：取要采用的值，编辑器保持原样；别处改了：取编辑器看到的值，
 * 本地没真改过就直接采用别处的新值。打开时做的规范化因此不会被当成本地编辑。
 */
function mergeBaseNodes(base: CanvasNodeData[], observed: CanvasNodeData[] | null, incoming: CanvasNodeData[], adopted: CanvasNodeData[]) {
    if (!observed && adopted === incoming) return base;
    const observedById = new Map((observed || []).map((node) => [node.id, node]));
    const incomingById = new Map(incoming.map((node) => [node.id, node]));
    const adoptedById = new Map(adopted.map((node) => [node.id, node]));
    return base.map((node) => {
        const seen = (observedById.get(node.id) ?? node) as unknown as Record<string, unknown>;
        const next = incomingById.get(node.id);
        if (!next) return seen as unknown as CanvasNodeData;
        const take = (adoptedById.get(node.id) ?? next) as unknown as Record<string, unknown>;
        if (sameValue(node, next)) return take as unknown as CanvasNodeData;
        const from = node as unknown as Record<string, unknown>;
        const to = next as unknown as Record<string, unknown>;
        const merged: Record<string, unknown> = {};
        for (const key of new Set([...Object.keys(from), ...Object.keys(to), ...Object.keys(take)])) {
            const value = sameValue(from[key], to[key]) ? take[key] : seen[key];
            if (value !== undefined) merged[key] = value;
        }
        return merged as unknown as CanvasNodeData;
    });
}

function sameJson(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sameEditorDocument(left: EditorDocument, right: EditorDocument) {
    return left.activeChatId === right.activeChatId
        && sameJson(left.nodes, right.nodes)
        && sameJson(left.connections, right.connections)
        && sameJson(left.chatSessions, right.chatSessions);
}

/** 助手会话按会话三路合并；同一会话两边都改过时抛错。 */
function mergeIncomingChatSessions(project: CanvasProject, base: CanvasAssistantSession[], incoming: CanvasAssistantSession[], live: CanvasAssistantSession[]) {
    if (sameJson(base, incoming) || sameJson(live, incoming)) return live;
    if (sameJson(live, base)) return incoming;
    const document = (chatSessions: CanvasAssistantSession[]): CanvasProject => ({ ...project, nodes: [], connections: [], chatSessions });
    const merged = rebaseCanvasDocumentThreeWay({ base: document(base), local: document(live), remote: document(incoming) });
    if (merged.conflict) throw new Error("助手会话在别处也改过，已保留本地会话");
    return merged.project.chatSessions || [];
}

/**
 * 把 base→incoming 这段别处写入的变化并到编辑器内容上：节点和连线逐个三路合并，
 * 助手会话逐个合并，当前会话只在编辑器没换过时跟随。同一处两边都改过时抛错，调用方保留编辑器内容。
 * `observed` 是编辑器对 base 的那份节点，用来判断本地真改动；`adopted` 是要采用的 incoming 节点（默认原样）。
 */
function mergeIncomingEditorDocument(
    project: CanvasProject,
    base: EditorDocument,
    incoming: EditorDocument,
    live: EditorDocument,
    options: { observed?: CanvasNodeData[] | null; adopted?: CanvasNodeData[] } = {},
): EditorDocument {
    const adopted = options.adopted ?? incoming.nodes;
    const graph = mergeCanvasRefreshPatch(
        { ...project, nodes: mergeBaseNodes(base.nodes, options.observed ?? null, incoming.nodes, adopted), connections: base.connections },
        { ...project, nodes: adopted, connections: incoming.connections },
        live.nodes,
        live.connections,
    );
    return {
        nodes: carryGenerationRecoveryRestore(graph.nodes, adopted),
        connections: graph.connections,
        chatSessions: mergeIncomingChatSessions(project, base.chatSessions, incoming.chatSessions, live.chatSessions),
        activeChatId: live.activeChatId === base.activeChatId ? incoming.activeChatId : live.activeChatId,
    };
}

type UseCanvasProjectLifecycleOptions = {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    canvasAppearance: CanvasAppearance;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    chatSessionsRef: MutableRefObject<CanvasAssistantSession[]>;
    activeChatIdRef: MutableRefObject<string | null>;
    viewportRef: MutableRefObject<ViewportTransform>;
    historyPausedRef: MutableRefObject<boolean>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setChatSessions: Dispatch<SetStateAction<CanvasAssistantSession[]>>;
    setActiveChatId: Dispatch<SetStateAction<string | null>>;
    setCanvasAppearance: Dispatch<SetStateAction<CanvasAppearance>>;
    setBackgroundMode: Dispatch<SetStateAction<CanvasBackgroundMode>>;
    setShowImageInfo: Dispatch<SetStateAction<boolean>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setProjectLoaded: Dispatch<SetStateAction<boolean>>;
    resetHistory: (snapshot: CanvasHistorySnapshot) => void;
    adoptExternalSnapshot: (overrides: Pick<CanvasHistorySnapshot, "nodes" | "connections">) => void;
    cleanupAssetImages: (options?: unknown) => void;
    cleanupCanvasFiles: (extra?: unknown) => void;
};

export function useCanvasProjectLifecycle({
    projectId,
    projectLoaded,
    nodes,
    connections,
    chatSessions,
    activeChatId,
    canvasAppearance,
    backgroundMode,
    showImageInfo,
    viewport,
    nodesRef,
    connectionsRef,
    chatSessionsRef,
    activeChatIdRef,
    viewportRef,
    historyPausedRef,
    setNodes,
    setConnections,
    setChatSessions,
    setActiveChatId,
    setCanvasAppearance,
    setBackgroundMode,
    setShowImageInfo,
    setViewport,
    setProjectLoaded,
    resetHistory,
    adoptExternalSnapshot,
    cleanupAssetImages,
    cleanupCanvasFiles,
}: UseCanvasProjectLifecycleOptions) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const localMode = isLocalWorkspaceMode();
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const [addedSkills, setAddedSkills] = useState<Skill[]>([]);
    const [loadError, setLoadError] = useState("");
    const [loadAttempt, setLoadAttempt] = useState(0);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const observedContentRef = useRef<CanvasHistorySnapshot | null>(null);
    const observedAtRender = observedContentRef.current;
    const loadLatestRef = useRef(false);
    const historyRestoreRef = useRef<{ snapshotId: string; revision: number; resolve: () => void; reject: (error: unknown) => void } | null>(null);
    const pendingReloadRef = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null);
    const editorReadyRef = useRef(false);
    // React keeps the previous canvas state for one render after the route id
    // changes. Track which project the live editor refs actually belong to so
    // that transition render can never persist A's snapshot into B (or vice versa).
    const editorProjectIdRef = useRef<string | null>(null);
    // The stored document the editor last lined up with, before editor-only
    // normalization. Anything another writer changed since then is merged into
    // editor writes instead of being overwritten by the editor's older copy.
    // observedContentRef is the editor's own copy of it (after open normalization):
    // live content is compared with that copy to tell real local edits apart.
    const observedStoreRef = useRef<CanvasProject | null>(null);
    const adoptExternalSnapshotRef = useRef(adoptExternalSnapshot);
    useLayoutEffect(() => {
        adoptExternalSnapshotRef.current = adoptExternalSnapshot;
    }, [adoptExternalSnapshot]);

    const storedEditorProject = () => useCanvasStore.getState().projects.find((project) => project.id === projectId);
    const liveEditorDocument = (): EditorDocument => ({ nodes: nodesRef.current, connections: connectionsRef.current, chatSessions: chatSessionsRef.current, activeChatId: activeChatIdRef.current });

    // Show a merged document. Session updates may still be queued for the next
    // render, so the session list is merged again against the newest value.
    const showMergedEditorDocument = (merged: EditorDocument, from: EditorDocument, base: CanvasProject | undefined, incoming: CanvasProject) => {
        nodesRef.current = merged.nodes;
        connectionsRef.current = merged.connections;
        setNodes(merged.nodes);
        setConnections(merged.connections);
        if (merged.chatSessions !== from.chatSessions) {
            chatSessionsRef.current = merged.chatSessions;
            setChatSessions((current) => {
                if (current === from.chatSessions || !base) return merged.chatSessions;
                try {
                    return mergeIncomingChatSessions(incoming, base.chatSessions || [], incoming.chatSessions || [], current);
                } catch {
                    // Keep the newer local sessions; the next editor write merges against the store again.
                    // The editor's node baseline already holds the incoming nodes, so replaying
                    // base→incoming onto it changes no node; only the sessions are merged again.
                    observedStoreRef.current = base;
                    return current;
                }
            });
        }
        if (merged.activeChatId !== from.activeChatId) {
            activeChatIdRef.current = merged.activeChatId;
            setActiveChatId((current) => current === from.activeChatId ? merged.activeChatId : current);
        }
        // 外部投影不是用户手工编辑：采用为历史基线，Ctrl+Z 不会倒退外部新值。
        adoptExternalSnapshotRef.current({ nodes: merged.nodes, connections: merged.connections });
    };

    /**
     * Merge a document another writer put in the store into the editor.
     * Without a base the incoming document replaces the editor content.
     * Same-field conflicts keep the editor content, hold the newer version and pause submits.
     * Local edits are told apart against the editor's own copy of the base, so open
     * normalization is never taken for one. Incoming content is taken as it is (running
     * uploads and tasks stay running); with `openRules` (the read that opens the canvas)
     * it is restored by the normal open rules. Editor content is never re-normalized.
     */
    const adoptIncomingEditorDocument = (base: CanvasProject | undefined, incoming: CanvasProject, options: { openRules?: boolean } = {}) => {
        const live = liveEditorDocument();
        const observed = observedContentRef.current;
        let merged: EditorDocument;
        let baseline: EditorDocument | null = null;
        try {
            if (base) {
                const baseDocument = editorDocumentOf(base);
                const incomingDocument = editorDocumentOf(incoming);
                const nodes = {
                    observed: base === observedStoreRef.current ? observed?.nodes ?? null : null,
                    adopted: options.openRules ? openCanvasNodes(incoming).nodes : incoming.nodes,
                };
                merged = mergeIncomingEditorDocument(incoming, baseDocument, incomingDocument, live, nodes);
                // Advance only the observed incoming fields; edits in live refs still
                // differ from this baseline and must be persisted by the autosave effect.
                if (observed) baseline = mergeIncomingEditorDocument(incoming, baseDocument, incomingDocument, editorDocumentOf(observed), nodes);
            } else {
                merged = editorDocumentOf(incoming);
                baseline = merged;
            }
        } catch (error) {
            // Keep the local edits on screen, but never let autosave silently
            // write this stale graph over the server: surface the newer version
            // and pause submits until the user picks it.
            traceCanvasGraph("editor.refresh.conflict", { previous: base, incoming, live: { id: projectId, nodes: live.nodes, connections: live.connections } });
            console.warn("画布外部改动与本地编辑冲突，已保留本地编辑", { id: projectId, error });
            holdExternalCanvasRevisionForEditor(incoming);
            return false;
        }
        traceCanvasGraph("editor.refresh", { previous: base, incoming, live: { id: projectId, nodes: live.nodes, connections: live.connections }, merged: { id: projectId, nodes: merged.nodes, connections: merged.connections } });
        if (observed && baseline) observedContentRef.current = { ...observed, ...baseline };
        observedStoreRef.current = incoming;
        showMergedEditorDocument(merged, live, base, incoming);
        return true;
    };

    /**
     * Editor content about to be written to the store. If another writer changed
     * the stored document since the editor last saw it, apply that change onto the
     * editor content first, so the write carries both sides.
     */
    const reconcileEditorSnapshot = <T extends EditorDocument>(snapshot: T): { next: T; merged: boolean } => {
        const stored = storedEditorProject();
        const base = observedStoreRef.current;
        if (!stored || !base || base.id !== projectId || stored === base) return { next: snapshot, merged: false };
        const baseDocument = editorDocumentOf(base);
        const storedDocument = editorDocumentOf(stored);
        if (sameEditorDocument(baseDocument, storedDocument)) {
            // Only non-editor fields moved (viewport, title): nothing to carry over.
            observedStoreRef.current = stored;
            return { next: snapshot, merged: false };
        }
        const live = liveEditorDocument();
        try {
            // Local edits are told apart against the editor's own copy of the base.
            const merged = mergeIncomingEditorDocument(stored, baseDocument, storedDocument, live, { observed: observedContentRef.current?.nodes ?? null });
            if (sameEditorDocument(merged, snapshot)) return { next: snapshot, merged: false };
            traceCanvasGraph("editor.write.rebase", { previous: base, incoming: stored, live: { id: projectId, nodes: live.nodes, connections: live.connections }, merged: { id: projectId, nodes: merged.nodes, connections: merged.connections } });
            showMergedEditorDocument(merged, live, base, stored);
            return { next: { ...snapshot, ...merged }, merged: true };
        } catch (error) {
            // Both sides changed the same content: the store keeps the editor
            // content as the local draft, the newer version is held and submits pause.
            traceCanvasGraph("editor.write.conflict", { previous: base, incoming: stored, live: { id: projectId, nodes: live.nodes, connections: live.connections } });
            console.warn("本地画布已在别处改动，与编辑器里的修改冲突，已保留编辑器内容", { id: projectId, error });
            holdExternalCanvasRevisionForEditor(stored);
            return { next: snapshot, merged: false };
        }
    };

    useEffect(() => {
        // The desktop repository is available independently of browser/session
        // hydration. Blocking local editing here leaves projectLoaded=false:
        // nodes appear on screen but every persistence effect is skipped.
        if (!localMode && (!hydrated || !sessionHydrated)) return;
        let cancelled = false;
        // Keep load intent on the refs until this attempt finishes. React Strict
        // Mode remounts the effect; consuming the flags here would turn "load
        // latest" into a normal open and immediately recreate the conflict.
        const latest = loadLatestRef.current;
        const historyRestore = historyRestoreRef.current;
        const pendingReload = pendingReloadRef.current;
        const keepEditor = editorReadyRef.current && (latest || Boolean(historyRestore));
        if (!keepEditor) {
            editorReadyRef.current = false;
            editorProjectIdRef.current = null;
            setProjectLoaded(false);
            setLoadError("");
            observedContentRef.current = null;
            observedStoreRef.current = null;
        }
        const applyRestoredProject = (targetProject: CanvasProject, options: { mergeLiveEdits?: boolean } = {}) => {
            traceCanvasGraph(cancelled ? "editor.restore.cancelled" : "editor.restore.apply", { target: targetProject, render: { id: projectId, nodes, connections }, live: { id: projectId, nodes: nodesRef.current, connections: connectionsRef.current } });
            if (cancelled || targetProject.id !== projectId) return;
            const observed = observedContentRef.current;
            const observedStore = observedStoreRef.current;
            if (
                options.mergeLiveEdits
                && editorReadyRef.current
                && editorProjectIdRef.current === targetProject.id
                && observed
                && observedStore?.id === targetProject.id
                && !sameEditorDocument(liveEditorDocument(), editorDocumentOf(observed))
            ) {
                // The cached canvas is already on screen and the user has edited it:
                // merge what was read into the editor instead of replacing it with
                // the graph from before the read. What was read is restored by the
                // same open rules as below; the editor's own content is kept as is.
                const { migration, hasNodeMigration } = openCanvasNodes(targetProject);
                if (hasNodeMigration) updateProject(targetProject.id, migration);
                adoptIncomingEditorDocument(observedStore, hasNodeMigration ? (storedEditorProject() ?? targetProject) : targetProject, { openRules: true });
                return;
            }
            const fallbackTheme = useCanvasThemeStore.getState().theme;
            const restoredAppearance = targetProject.appearance
                ? normalizeCanvasAppearance(targetProject.appearance, fallbackTheme)
                : canvasAppearanceForTheme(fallbackTheme);
            const { nodes: initialNodes, migration, hasNodeMigration } = openCanvasNodes(targetProject);
            if (hasNodeMigration) updateProject(targetProject.id, migration);
            const snapshot: CanvasHistorySnapshot = {
                nodes: initialNodes,
                connections: targetProject.connections,
                chatSessions: targetProject.chatSessions || [],
                activeChatId: targetProject.activeChatId || null,
                canvasAppearance: restoredAppearance,
                backgroundMode: targetProject.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                showImageInfo: targetProject.showImageInfo || false,
            };
            observedContentRef.current = hasNodeMigration ? { ...snapshot, nodes: targetProject.nodes } : snapshot;
            observedStoreRef.current = hasNodeMigration ? (storedEditorProject() ?? targetProject) : targetProject;
            chatSessionsRef.current = snapshot.chatSessions;
            activeChatIdRef.current = snapshot.activeChatId;
            nodesRef.current = snapshot.nodes;
            connectionsRef.current = snapshot.connections;
            viewportRef.current = targetProject.viewport;
            setNodes(snapshot.nodes);
            setConnections(snapshot.connections);
            setChatSessions(snapshot.chatSessions);
            setActiveChatId(snapshot.activeChatId);
            setCanvasAppearance(snapshot.canvasAppearance);
            useCanvasThemeStore.getState().setAppearance(snapshot.canvasAppearance);
            setBackgroundMode(snapshot.backgroundMode);
            setShowImageInfo(snapshot.showImageInfo);
            setViewport(targetProject.viewport);
            resetHistory(snapshot);
            editorReadyRef.current = true;
            editorProjectIdRef.current = targetProject.id;
            setProjectLoaded(true);
        };

        const load = async () => {
            const cachedProject = useCanvasStore.getState().projects.find((p) => p.id === projectId);
            if (!latest && !historyRestore && cachedProject) {
                traceCanvasGraph("editor.load.cache", { cached: cachedProject });
                // 本地已有该画布的持久化缓存：先以本地数据秒开渲染，彻底消除白屏与等待
                applyRestoredProject(cachedProject);
            }
            // An explicit "load latest" or history restore replaces the editor on purpose.
            const mergeLiveEdits = !latest && !historyRestore;
            const loadedProject = await loadCanvasProjectForEditing(projectId, { latest, historyRestore: historyRestore || undefined, onLoad: (project) => applyRestoredProject(project, { mergeLiveEdits }) });
            traceCanvasGraph("editor.load.return", { loaded: loadedProject, stored: useCanvasStore.getState().openProject(projectId) });
            if (cancelled) return;
            if (historyRestoreRef.current === historyRestore) {
                historyRestoreRef.current = null;
                historyRestore?.resolve();
            }
            if (!loadedProject) {
                if (!cachedProject) navigate("/canvas", { replace: true });
                return;
            }
            const project = useCanvasStore.getState().projects.find((p) => p.id === projectId) || loadedProject;

            // 画布媒体由节点自己的视口观察器按需加载；打开时遍历并解析全部节点会让大画布形成 N+1 资源读取。
            void hydrateAssistantImages(project.chatSessions || [])
                .then((hydratedSessions) => {
                    if (!cancelled) setChatSessions((current) => {
                        const merged = mergeHydratedSessions(current, hydratedSessions);
                        if (observedContentRef.current?.chatSessions === current) observedContentRef.current = { ...observedContentRef.current, chatSessions: merged };
                        return merged;
                    });
                })
                .catch(() => {
                    if (!cancelled) message.warning("部分助手会话素材恢复失败，已使用项目记录继续打开");
                });
        };
        void load()
            .then(() => {
                if (cancelled) return;
                loadLatestRef.current = false;
                if (pendingReloadRef.current === pendingReload) {
                    pendingReloadRef.current = null;
                    pendingReload?.resolve();
                }
            })
            .catch((error) => {
                if (cancelled) return;
                loadLatestRef.current = false;
                if (historyRestoreRef.current === historyRestore) {
                    historyRestoreRef.current = null;
                    historyRestore?.reject(error);
                }
                if (pendingReloadRef.current === pendingReload) {
                    pendingReloadRef.current = null;
                    pendingReload?.reject(error);
                }
                const detail = error instanceof Error ? error.message : (localMode ? "读取本地画布失败，请重试" : "读取画布失败，请重试");
                if (projectSyncProgress(projectId)?.phase !== "conflict") useSyncProgressStore.getState().setProjectProgress(projectId, { phase: "error", message: localMode ? detail : (error instanceof Error ? error.message : "读取云端版本失败") });
                if (keepEditor) message.error(detail);
                else setLoadError(detail);
            });
        return () => {
            cancelled = true;
        };
    }, [hydrated, sessionHydrated, loadAttempt, message, navigate, openProject, projectId, resetHistory, setActiveChatId, setBackgroundMode, setCanvasAppearance, setChatSessions, setConnections, setNodes, setShowImageInfo, setViewport]);

    useEffect(() => {
        if (!projectLoaded) return;
        let cancelled = false;
        if (localMode) {
            setAddedSkills([]);
            return () => { cancelled = true; };
        }
        listAddedSkills()
            .then(({ skills }) => {
                if (!cancelled) setAddedSkills(skills);
            })
            .catch(() => {
                if (!cancelled) setAddedSkills([]);
            });
        return () => {
            cancelled = true;
        };
    }, [localMode, projectLoaded]);

    useEffect(() => subscribeCanvasRefresh((project, previous) => {
        if (!projectLoaded || editorProjectIdRef.current !== projectId || project.id !== projectId) return;
        // Merge only server-changed content (graph and assistant sessions) so
        // dragging/editing other nodes can continue while Agent media tasks
        // complete. Same-field conflicts keep the editor content and hold.
        // The base is what the editor last lined up with, so store writes it was
        // never told about are merged as well.
        const observedStore = observedStoreRef.current?.id === projectId ? observedStoreRef.current : null;
        adoptIncomingEditorDocument(previous ? (observedStore ?? previous) : undefined, project);
    }), [adoptExternalSnapshot, projectId, projectLoaded, nodesRef, connectionsRef, setNodes, setConnections]);

    useEffect(() => {
        if (!projectLoaded || editorProjectIdRef.current !== projectId || historyPausedRef.current) return;
        // An earlier load/refresh effect can advance the baseline and enqueue new React state
        // in this same effect batch. This render still owns the old graph, not a user deletion.
        if (observedContentRef.current !== observedAtRender) return;
        const snapshot = { nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo };
        if (!observedContentRef.current) return;
        if (JSON.stringify(observedContentRef.current) === JSON.stringify(snapshot)) {
            // Task acknowledgements can already be present in the store before
            // this editor observes them. Equal local graphs still need a CAS save
            // when the backend has not confirmed that document yet.
            if (localMode && hasUnconfirmedCanvasEdits(projectId)) scheduleLocalCanvasBackendSync(projectId);
            return;
        }
        traceCanvasGraph("editor.autosave", { observed: { id: projectId, ...observedContentRef.current }, render: { id: projectId, ...snapshot }, live: { id: projectId, nodes: nodesRef.current, connections: connectionsRef.current }, stored: useCanvasStore.getState().openProject(projectId) });
        // Another writer may have changed the stored document after this editor
        // last saw it (for example the opened backend graph landing). Carry those
        // changes instead of writing this render's older copy over them.
        const { next } = reconcileEditorSnapshot(snapshot);
        observedContentRef.current = next;
        const patch = { nodes: next.nodes, connections: next.connections, chatSessions: next.chatSessions, activeChatId: next.activeChatId, appearance: canvasAppearance, backgroundMode, showImageInfo };
        const stored = storedEditorProject();
        // 远端结果投影到编辑器不是一次本地编辑，避免改写时间戳并触发反向保存。
        if (stored && Object.entries(patch).every(([key, value]) => JSON.stringify(stored[key as keyof CanvasProject]) === JSON.stringify(value))) {
            observedStoreRef.current = stored;
            if (localMode && hasUnconfirmedCanvasEdits(projectId)) scheduleLocalCanvasBackendSync(projectId);
            return;
        }
        updateProject(projectId, patch);
        observedStoreRef.current = storedEditorProject() ?? observedStoreRef.current;
        if (localMode) scheduleLocalCanvasBackendSync(projectId);
    }, [activeChatId, backgroundMode, canvasAppearance, chatSessions, connections, historyPausedRef, nodes, observedAtRender, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!projectLoaded || editorProjectIdRef.current !== projectId) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            if (editorProjectIdRef.current !== projectId) return;
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport, viewportRef]);

    useEffect(() => () => {
        if (!projectLoaded || editorProjectIdRef.current !== projectId) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        updateProject(projectId, { viewport: viewportRef.current });
    }, [projectId, projectLoaded, updateProject, viewportRef]);

    // Non-ref editor state for the leave flush. Synced in a layout effect, not
    // during render, so the route-change render cannot hand B's state to A's flush.
    const leaveFlushStateRef = useRef({ chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo });
    useLayoutEffect(() => {
        leaveFlushStateRef.current = { chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo };
    }, [activeChatId, backgroundMode, canvasAppearance, chatSessions, showImageInfo]);

    // Leaving the canvas (route change, project switch, unmount) or hiding the
    // page must not depend on the 400 ms store timer or the 500 ms backend timer.
    useEffect(() => {
        if (!projectLoaded) return;
        const owner = captureUserScope();
        const flushOnLeave = (reason: string) => {
            if (!userScopeMatches(owner)) return;
            if (editorProjectIdRef.current !== projectId) return;
            if (!useCanvasStore.getState().openProject(projectId)) return;
            const live = leaveFlushStateRef.current;
            const snapshot = { nodes: nodesRef.current, connections: connectionsRef.current, ...live };
            if (observedContentRef.current && JSON.stringify(observedContentRef.current) !== JSON.stringify(snapshot)) {
                traceCanvasGraph("editor.leaveFlush", { observed: { id: projectId, ...observedContentRef.current }, live: { id: projectId, ...snapshot }, stored: useCanvasStore.getState().openProject(projectId) });
                const { next } = reconcileEditorSnapshot(snapshot);
                updateProject(projectId, {
                    nodes: next.nodes,
                    connections: next.connections,
                    chatSessions: next.chatSessions,
                    activeChatId: next.activeChatId,
                    appearance: next.canvasAppearance,
                    backgroundMode: next.backgroundMode,
                    showImageInfo: next.showImageInfo,
                });
                observedContentRef.current = next;
                observedStoreRef.current = storedEditorProject() ?? observedStoreRef.current;
            }
            updateProject(projectId, { viewport: viewportRef.current });
            void (async () => {
                await flushCanvasStorePersistence();
                if (!userScopeMatches(owner)) return;
                if (localMode) await syncLocalCanvasProjectToBackend(projectId, owner);
            })().catch((error) => {
                if (isCanvasSubmitControlError(error)) return;
                console.error("离开画布时保存失败", { projectId, reason, error });
            });
        };
        const handlePageHide = () => flushOnLeave("pagehide");
        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") flushOnLeave("hidden");
        };
        window.addEventListener("pagehide", handlePageHide);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.removeEventListener("pagehide", handlePageHide);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            flushOnLeave("leave");
        };
    }, [connectionsRef, localMode, nodesRef, projectId, projectLoaded, updateProject, viewportRef]);

    const createAndOpenCanvas = useCallback(() => {
        const workspaceProjectId = currentProject ? canvasWorkspaceProjectId(currentProject) : undefined;
        const domainProjectId = currentProject?.projectId;
        if (localMode) {
            void createWorkspaceCanvasProject("未命名画布", domainProjectId, undefined, workspaceProjectId)
                .then(({ id }) => navigate(`/canvas/${id}`))
                .catch((error) => message.error(error instanceof Error ? `新建画布失败：${error.message}` : "新建画布失败，请稍后重试"));
            return;
        }
        void createWorkspaceCanvasProject("未命名画布", domainProjectId, undefined, workspaceProjectId).then(({ id, syncError }) => {
            // 本地/访客模式下没有远端同步会话，这是预期状态，不应在画布中央弹出错误 toast。
            if (syncError && !isExpectedLocalOnlySyncError(syncError)) message.warning(syncError instanceof Error ? `画布已在本地创建，云端同步失败：${syncError.message}` : "画布已在本地创建，云端同步失败");
            navigate(`/canvas/${id}`);
        }).catch((error) => message.error(error instanceof Error ? `新建画布失败：${error.message}` : "新建画布失败，请稍后重试"));
    }, [currentProject, localMode, message, navigate]);

    const deleteCurrentProject = useCallback(async () => {
        const scope = captureUserScope();
        const siblingCanvases = listCanvasWorkspaceProjectCanvases(useCanvasStore.getState().projects, projectId);
        const nextCanvas = siblingCanvases.find((canvas) => canvas.id !== projectId);
        let drawingIds = nodesRef.current.flatMap((node) => node.type === "drawing" && node.metadata?.drawingId ? [node.metadata.drawingId] : []);
        const drafts = await readCanvasSyncDrafts(projectId);
        assertUserScope(scope);
        const preserved = new Set(drafts.flatMap((draft) => draft.project.nodes.flatMap((node) => node.metadata?.drawingId ? [node.metadata.drawingId] : [])));
        drawingIds = drawingIds.filter((id) => !preserved.has(id));
        await deleteWorkspaceCanvasProjects([projectId]);
        assertUserScope(scope);
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId)))
                .catch(() => { if (userScopeMatches(scope)) message.warning("画布已删除，但部分本地绘图缓存清理失败"); });
        }
        cleanupAssetImages();
        navigate(nextCanvas ? `/canvas/${nextCanvas.id}` : "/canvas");
    }, [cleanupAssetImages, localMode, message, navigate, nodesRef, projectId]);

    const renameCurrentProject = useCallback((title: string) => {
        if (!currentProject) return;
        renameProject(canvasWorkspaceProjectId(currentProject), title);
    }, [currentProject, renameProject]);

    const persistLocalEdits = useCallback(async () => {
        if (!projectLoaded || editorProjectIdRef.current !== projectId) return;
        const snapshot = { nodes: nodesRef.current, connections: connectionsRef.current, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo };
        if (observedContentRef.current && JSON.stringify(observedContentRef.current) !== JSON.stringify(snapshot)) {
            traceCanvasGraph("editor.explicitSave", { observed: { id: projectId, ...observedContentRef.current }, live: { id: projectId, ...snapshot }, stored: useCanvasStore.getState().openProject(projectId) });
            const { next } = reconcileEditorSnapshot(snapshot);
            updateProject(projectId, {
                nodes: next.nodes,
                connections: next.connections,
                chatSessions: next.chatSessions,
                activeChatId: next.activeChatId,
                appearance: canvasAppearance,
                backgroundMode,
                showImageInfo,
                viewport: viewportRef.current,
            });
            observedContentRef.current = next;
            observedStoreRef.current = storedEditorProject() ?? observedStoreRef.current;
        }
        updateProject(projectId, { viewport: viewportRef.current });
        await flushCanvasStorePersistence();
        if (localMode) await syncLocalCanvasProjectToBackend(projectId);
    }, [activeChatId, backgroundMode, canvasAppearance, chatSessions, connectionsRef, localMode, nodesRef, projectId, projectLoaded, showImageInfo, updateProject, viewportRef]);

    const reloadLatestCanvasProject = useCallback(async () => {
        await persistLocalEdits();
        return new Promise<void>((resolve, reject) => {
            pendingReloadRef.current?.reject(new Error("已有新的加载请求"));
            loadLatestRef.current = true;
            pendingReloadRef.current = { resolve, reject };
            setLoadAttempt((value) => value + 1);
        });
    }, [persistLocalEdits]);

    const restoreCanvasProjectVersion = useCallback(async (snapshotId: string, revision: number) => {
        await persistLocalEdits();
        return new Promise<void>((resolve, reject) => {
            historyRestoreRef.current?.reject(new Error("已有新的恢复请求"));
            historyRestoreRef.current = { snapshotId, revision, resolve, reject };
            setLoadAttempt((value) => value + 1);
        });
    }, [persistLocalEdits]);

    const saveCanvasProject = useCallback(async (options: { requireRemote?: boolean } = {}): Promise<boolean> => {
        try {
            await persistLocalEdits();
        } catch {
            message.error("画布保存失败，请稍后重试");
            return false;
        }
        if (!hasRemoteUserDataSyncSession()) {
            message.success("画布已保存到本地");
            return true;
        }
        try {
            await saveRemoteUserDataNow(projectId);
            message.success("画布已保存到云端");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "未知错误";
            if (!isExpectedLocalOnlySyncError(error)) message.warning(`本地画布布局已保存，云端同步失败：${detail}`);
            // Imports can retain their durable local result; sharing requires cloud success.
            return options.requireRemote === false;
        }
        return true;
    }, [message, persistLocalEdits, projectId]);

    const forceSaveCanvasProject = useCallback(async (): Promise<boolean> => {
        try { await persistLocalEdits(); } catch { message.error("本地保存失败，请重试"); return false; }
        try {
            const result = await forceOverwriteRemoteCanvasSync();
            message.success(result.reboundNodes > 0 ? `已保存，并修复 ${result.reboundNodes} 处媒体与素材的绑定` : "素材关联已核对，画布已保存");
        } catch (error) {
            message.error(`修复并保存失败：${error instanceof Error ? error.message : "未知错误"}`);
            return false;
        }
        return true;
    }, [message, persistLocalEdits]);

    const clearCanvasFiles = useCallback(() => {
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, projectId]);

    return {
        loadError,
        retryLoad: () => setLoadAttempt((attempt) => attempt + 1),
        addedSkills,
        clearCanvasFiles,
        createAndOpenCanvas,
        currentProject,
        deleteCurrentProject,
        renameCurrentProject,
        reloadLatestCanvasProject,
        restoreCanvasProjectVersion,
        saveCanvasProject,
        forceSaveCanvasProject,
        updateProject,
    };
}


function mergeHydratedSessions(currentSessions: CanvasAssistantSession[], hydratedSessions: CanvasAssistantSession[]) {
    const hydratedById = new Map(hydratedSessions.map((session) => [session.id, session]));
    return currentSessions.map((session) => {
        const hydrated = hydratedById.get(session.id);
        if (!hydrated) return session;
        const hydratedMessages = new Map(hydrated.messages.map((message) => [message.id, message]));
        return {
            ...session,
            messages: session.messages.map((message) => {
                const hydratedMessage = hydratedMessages.get(message.id);
                if (!hydratedMessage || !message.references?.length) return message;
                const hydratedReferences = new Map((hydratedMessage.references || []).map((reference) => [reference.id, reference]));
                return {
                    ...message,
                    references: message.references.map((reference) => {
                        const hydratedReference = hydratedReferences.get(reference.id);
                        return hydratedReference ? { ...reference, dataUrl: hydratedReference.dataUrl, storageKey: hydratedReference.storageKey } : reference;
                    }),
                };
            }),
        };
    });
}
