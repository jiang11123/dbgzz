import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasGeneration } from "../../src/pages/canvas/use-canvas-generation";
import { useCanvasGenerationExecutor } from "../../src/pages/canvas/use-canvas-generation-executor";
import { stampCanvasNodeChanges } from "../../src/lib/canvas/canvas-node-timestamps";
import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "../../src/stores/use-config-store";
import { useCanvasProjectLifecycle } from "../../src/pages/canvas/use-canvas-project-lifecycle";
import { useCanvasHistory } from "../../src/pages/canvas/use-canvas-history";
import { canvasAppearanceForTheme } from "../../src/lib/canvas/canvas-appearance";
import { useCanvasStore, flushCanvasStorePersistence } from "../../src/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { recordConfirmedCanvasCommit } from "../../src/services/canvas-operation-journal";
import { applyGenerationConsumerEffect } from "../../src/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "../../src/services/generation-task-materializer";
import { hasUnconfirmedCanvasEdits, pendingExternalCanvasRevision } from "../../src/services/local-workspace-repository";
import { canvasBackendSubmitPaused } from "../../src/services/canvas-revision-conflict";
import { syncLocalCanvasProjectToBackend } from "../../src/services/local-workspace-repository";
import { refreshLocalCanvasProjectIfChanged } from "../../src/services/local-workspace-repository";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import type { CanvasNodeData, CanvasConnection, CanvasAssistantSession } from "../../src/types/canvas";

const noop = () => {};
const cached = (window as any).__reopenProject ?? { id: "c1", revision: 105, title: "Restart", createdAt: "2026-10-02", updatedAt: "2026-10-02", nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, width: 320, height: 200, position: { x: i * 400, y: 0 }, metadata: {} })), connections: [], chatSessions: [], activeChatId: null, appearance: canvasAppearanceForTheme("dark"), backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
const harness = (window as any).__lifecycle = { renders: [], updates: [], media: noop, deleteEdges: noop, save: async () => {}, restartLoad: async (_remote: unknown) => {}, setSession: (ready: boolean) => useUserStore.getState().setHydrated(ready) };
const scenario = new URLSearchParams(location.search).get("scenario");
const channel = createModelChannel({ id: "synthetic", name: "Synthetic", baseUrl: location.origin + "/upstream", apiKey: "synthetic-not-a-secret", interfaceType: "openai-image", models: ["gpt-image-2.5"] });
const imageModel = encodeChannelModel(channel.id, "gpt-image-2.5");
if (scenario === "image-save") {
    useConfigStore.getState().replaceConfig({ ...defaultConfig, channels: [channel], model: imageModel, imageModel, models: [imageModel], size: "9:16", quality: "high" });
    cached.nodes[0].metadata = { model: imageModel, size: "9:16", count: "1", quality: "high", prompt: "Short storyboard description", composerContent: "A detailed synthetic image prompt", content: "", status: "idle" };
}
if (scenario === "interrupted") {
    // The canvas was closed mid-work: a generation was running on n2 and uploads on n3 and n4.
    cached.nodes[2].metadata = { status: "loading", taskId: "task-done" };
    cached.nodes[3].metadata = { fileUpload: "uploading", fileUploadProgress: 40 };
    cached.nodes[4].metadata = { fileUpload: "uploading", fileUploadProgress: 40 };
}
if (scenario === "late-same-node-recovery") cached.nodes[0].metadata = { prompt: "Original prompt" };
await useCanvasStore.persist.rehydrate();
if (scenario !== "missing-cache-and-journal") await recordConfirmedCanvasCommit(cached as never);
const local = structuredClone(cached);
if (scenario === "dirty-cache") local.nodes[0]!.title = "Unsaved manual title";
if (scenario === "startup-stamp" || scenario === "missing-chat-sessions") local.nodes[0]!.metadata = applyGenerationConsumerEffect(local.nodes[0]!.metadata || {}, attachNodeEffectKey("completed-task-receipt", "n0", 0), metadata => metadata).value;
if (scenario === "missing-chat-sessions") delete (local as any).chatSessions;
useCanvasStore.setState({ projects: scenario?.startsWith("missing-cache") ? [] : [local as never], hydrated: true });
await flushCanvasStorePersistence();
useUserStore.getState().setHydrated(true);
useCanvasStore.subscribe((state) => { const p = state.projects.find(p => p.id === "c1"); if (p) harness.updates.push({ edges: p.connections.length, revision: p.revision }); });

function Recovery({ projectId, projectLoaded, nodes, nodesRef, setNodes }: Parameters<typeof useCanvasGeneration>[0]) {
    useCanvasGeneration({ projectId, projectLoaded, nodes, nodesRef, setNodes });
    return null;
}

function Harness() {
    const [projectId, setProjectId] = useState("c1");
    (harness as any).switchCanvas = setProjectId;
    (harness as any).scopeCycle = () => { const scope = getActiveUserScope(); setActiveUserScope("leave-owner-b"); setActiveUserScope(scope); };
    const [, unrelatedRender] = useState(0);
    (harness as any).pulse = () => new Promise<void>(resolve => {
        let count = 0;
        const timer = setInterval(() => {
            unrelatedRender(value => value + 1);
            if (++count === 17) { clearInterval(timer); resolve(); }
        }, 50);
    });
    const [nodes, setNodesState] = useState<CanvasNodeData[]>([]);
    const nodesRef = useRef(nodes);
    // Use the page's updater contract: functional updates also advance the live
    // ref, while direct generation writes reach it synchronously.
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>(value => {
        if (typeof value === "function") {
            setNodesState(current => {
                const next = stampCanvasNodeChanges(current, value(current));
                nodesRef.current = next;
                return next;
            });
        } else {
            const next = stampCanvasNodeChanges(nodesRef.current, value);
            nodesRef.current = next;
            setNodesState(next);
        }
    }, []);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [canvasAppearance, setCanvasAppearance] = useState(() => canvasAppearanceForTheme("dark"));
    const [backgroundMode, setBackgroundMode] = useState<any>("grid");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const [projectLoaded, setProjectLoaded] = useState(false);
    const connectionsRef = useRef(connections), chatSessionsRef = useRef(chatSessions), activeChatIdRef = useRef(activeChatId), viewportRef = useRef(viewport);
    const history = useCanvasHistory({ projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, setNodes, setConnections, setChatSessions, setActiveChatId, applyCanvasAppearance: setCanvasAppearance, setBackgroundMode, setShowImageInfo, setSelectedNodeIds: noop, setSelectedConnectionId: noop, setContextMenu: noop });
    useCanvasProjectLifecycle({ projectId, projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, viewport, nodesRef, connectionsRef, chatSessionsRef, activeChatIdRef, viewportRef, historyPausedRef: history.historyPausedRef, setNodes, setConnections, setChatSessions, setActiveChatId, setCanvasAppearance, setBackgroundMode, setShowImageInfo, setViewport, setProjectLoaded, resetHistory: history.resetHistory, adoptExternalSnapshot: history.adoptExternalSnapshot, cleanupAssetImages: noop, cleanupCanvasFiles: noop });
    const generation = useCanvasGeneration({ projectId, projectLoaded: false, nodes, nodesRef, setNodes });
    const generate = useCanvasGenerationExecutor({ projectId, addedSkills: [], assets: [], nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop,
        setRunningNodeId: generation.setRunningNodeId, startGenerationRequest: generation.startGenerationRequest, finishGenerationRequest: generation.finishGenerationRequest, bindGenerationTask: generation.bindGenerationTask, applyGenerationTaskResult: generation.applyGenerationTaskResult });
    (harness as any).generateImage = async () => {
        // Hold the first write-back so the editor still has its pre-generation
        // baseline. Flush at the store publication boundary to exercise the
        // preparation/submission race independently of React scheduling speed.
        history.historyPausedRef.current = true;
        const controller = new AbortController();
        (harness as any).controller = controller;
        const stop = useCanvasStore.subscribe(state => {
            const target = state.openProject("c1")?.nodes[0];
            if (target?.metadata?.generationSubmissionState !== "submitting") return;
            stop();
            window.dispatchEvent(new Event("pagehide"));
        });
        try {
            await generate("n0", "image", nodesRef.current[0]!.metadata!.composerContent!, { controller, clientOperationId: "proposal:synthetic:n0", confirmedInputs: { nodes: cached.nodes, connections: [], config: useConfigStore.getState().config, assets: [], skills: [] }, onSubmissionPlan: async manifest => {
                await fetch("/_manifest", { method: "POST", body: JSON.stringify(manifest) });
            } });
        } finally { stop(); (harness as any).generationSettled = true; }
    };
    useLayoutEffect(() => { nodesRef.current = nodes; connectionsRef.current = connections; chatSessionsRef.current = chatSessions; activeChatIdRef.current = activeChatId; viewportRef.current = viewport; }, [nodes, connections, chatSessions, activeChatId, viewport]);
    useEffect(() => { harness.renders.push({ nodes: nodes.length, edges: connections.length, projectLoaded }); });
    (harness as any).dirty = () => hasUnconfirmedCanvasEdits("c1");
    (harness as any).hydrateCompletedTaskStamp = () => {
        // A completed task already has its media bound. Recovery records only the
        // consumer acknowledgement, before the editor sees the same store graph.
        const effectKey = attachNodeEffectKey("completed-task-receipt", "n0", 0);
        const next = nodesRef.current.map(node => node.id === "n0" ? { ...node,
            metadata: applyGenerationConsumerEffect(node.metadata || {}, effectKey, metadata => metadata).value } : node);
        useCanvasStore.getState().updateProject("c1", { nodes: next });
        nodesRef.current = next;
        setNodes(next);
        return effectKey;
    };
    harness.media = () => setNodes(current => current.map((node, i) => i === 1 ? { ...node, width: node.width + 1 } : node));
    harness.restartLoad = async (remote: unknown) => { await recordConfirmedCanvasCommit(remote as never); useCanvasStore.setState({ projects: [remote as never] }); useUserStore.getState().setHydrated(false); harness.media(); };
    harness.deleteEdges = () => setConnections([]);
    (harness as any).editTitle = () => setNodes(current => current.map(node => node.id === "n0" ? { ...node, title: "Local unsaved text" } : node));
    // Same pattern as the canvas page: the live ref moves synchronously with the edit.
    const editTitleNow = () => {
        const next = nodesRef.current.map(node => node.id === "n0" ? { ...node, title: "Local unsaved text" } : node);
        nodesRef.current = next;
        setNodes(next);
    };
    (harness as any).editTitleNow = editTitleNow;
    // Edit exactly when the backend graph lands in the store, while the editor still shows the cached graph.
    const editWhenBackendProjects = (edit: () => void) => {
        const stop = useCanvasStore.subscribe((state) => {
            const project = state.projects.find(p => p.id === "c1");
            if (!project || project.connections.length !== 6 || connectionsRef.current.length !== 0) return;
            stop();
            edit();
        });
    };
    (harness as any).editWhenBackendProjects = () => editWhenBackendProjects(editTitleNow);
    (harness as any).editPromptWhenBackendProjects = () => editWhenBackendProjects(() => {
        const next = nodesRef.current.map(node => node.id === "n0" ? { ...node, metadata: { ...node.metadata, prompt: "Unsaved local prompt" } } : node);
        nodesRef.current = next;
        setNodes(next);
    });
    (harness as any).chatIds = () => chatSessionsRef.current.map(session => session.id);
    (harness as any).held = () => ({ paused: canvasBackendSubmitPaused("c1"), candidateTitle: (pendingExternalCanvasRevision("c1")?.candidate.nodes[0] as CanvasNodeData | undefined)?.title ?? null });
    (harness as any).title = () => nodesRef.current.find(node => node.id === "n0")?.title;
    (harness as any).nodeState = (id: string) => { const node = nodesRef.current.find(item => item.id === id); return node ? { title: node.title, metadata: node.metadata } : null; };
    // Another writer adds a node to the stored canvas without telling the editor.
    (harness as any).addStoredNode = (node: CanvasNodeData) => { const project = useCanvasStore.getState().projects.find(p => p.id === "c1")!; useCanvasStore.getState().updateProject("c1", { nodes: [...project.nodes, node] }); };
    // A node drag holds history (and with it autosave) until the drag ends.
    (harness as any).pauseHistory = (paused: boolean) => { history.historyPausedRef.current = paused; };
    (harness as any).refresh = () => refreshLocalCanvasProjectIfChanged(projectId);
    harness.save = async () => { await flushCanvasStorePersistence(); await syncLocalCanvasProjectToBackend("c1"); };
    return <>
        <button onClick={() => setNodes(current => current.map(node => node.id === "n0" ? { ...node, metadata: { ...node.metadata, model: "beefapi::seedance-2.0-mini" } } : node))}>Switch video model</button>
        <div data-testid="graph">{`${projectLoaded}:${nodes.length}:${connections.length}`}</div>
        {(scenario === "late-recovery" || scenario === "late-same-node-recovery") && <Recovery projectId={projectId} projectLoaded={projectLoaded} nodes={nodes} nodesRef={nodesRef} setNodes={setNodes} />}
    </>;
}
function MountController() {
    const [mounted, setMounted] = useState(true);
    (harness as any).unmount = () => setMounted(false);
    return mounted ? <Harness /> : <div data-testid="unmounted">Left canvas</div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><MemoryRouter><QueryClientProvider client={new QueryClient()}><App><MountController /></App></QueryClientProvider></MemoryRouter></StrictMode>);
