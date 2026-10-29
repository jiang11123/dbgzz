import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasGeneration } from "../../src/pages/canvas/use-canvas-generation";
import { resetInterruptedGeneration } from "../../src/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "../../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";

// Drives the real useCanvasGeneration with the same restore step the project
// lifecycle uses: every applied snapshot goes through resetInterruptedGeneration,
// first for the cached copy (projectLoaded false -> true) and again when the
// remote copy arrives while projectLoaded is already true.

const settledNode = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "success", content: `/api/resources/${id}/file`, storageKey: `resource:${id}` } });
const projectNodes: Record<string, CanvasNodeData[]> = { "canvas-a": [settledNode("node-cached")], "canvas-b": [settledNode("node-b")] };

await useCanvasStore.persist.rehydrate();
useCanvasStore.setState({
    projects: Object.entries(projectNodes).map(([id, nodes]) => ({ id, title: id, nodes, connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-01", updatedAt: "2026-10-01" })),
});

type LateHarness = {
    remoteLoad(extra: CanvasNodeData[]): void;
    refreshMerge(extra: CanvasNodeData[]): void;
    regenerate(nodeId: string): void;
    startFreshRequest(): void;
    startFreshBatch(): void;
    bindFreshTask(): void;
    queueRecoveryAndBind(): void;
    switchProject(id: string): void;
    unmount(): void;
    snapshot(): { projectId: string; nodes: CanvasNodeData[]; freshAborted: boolean | null; store: Record<string, CanvasNodeData[]> };
};
declare global {
    interface Window {
        lateHarness?: LateHarness;
    }
}

const root = createRoot(document.getElementById("root")!);

function Harness() {
    const [projectId, setProjectId] = useState("canvas-a");
    const [projectLoaded, setProjectLoaded] = useState(true);
    const nodesRef = useRef<CanvasNodeData[]>(resetInterruptedGeneration(projectNodes["canvas-a"]));
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const [nodes, setNodesState] = useState<CanvasNodeData[]>(nodesRef.current);
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>((value) => {
        if (typeof value === "function") {
            setNodesState((current) => {
                const next = value(current);
                nodesRef.current = next;
                return next;
            });
            return;
        }
        nodesRef.current = value;
        setNodesState(value);
    }, []);
    useEffect(() => {
        useCanvasStore.getState().updateProject(projectId, { nodes });
    }, [nodes, projectId]);
    const generation = useCanvasGeneration({ projectId, projectLoaded, nodes, nodesRef, setNodes });
    const generationRef = useRef(generation);
    generationRef.current = generation;
    const freshControllerRef = useRef<AbortController | null>(null);

    useEffect(() => {
        window.lateHarness = {
            remoteLoad(extra) {
                // Remote copy = what the server holds (the live graph, including
                // nodes the client already autosaved) plus nodes this client never saw.
                const restored = resetInterruptedGeneration([...nodesRef.current.filter((node) => !extra.some((item) => item.id === node.id)), ...extra]);
                nodesRef.current = restored;
                setNodesState(restored);
                setProjectLoaded(true);
            },
            refreshMerge(extra) {
                // subscribeCanvasRefresh merges server-changed nodes without the restore step.
                const next = [...nodesRef.current.filter((node) => !extra.some((item) => item.id === node.id)), ...extra];
                nodesRef.current = next;
                setNodesState(next);
            },
            regenerate(nodeId) {
                // Same shape as an in-place regeneration: loading, error cleared, old task id kept until the new task binds.
                const controller = new AbortController();
                const next = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "loading" as const, errorDetails: undefined } } : node));
                nodesRef.current = next;
                setNodesState(next);
                generationRef.current.startGenerationRequest(nodeId, nodeId, nodeId, controller);
            },
            startFreshRequest() {
                const controller = new AbortController();
                freshControllerRef.current = controller;
                const next = [
                    ...nodesRef.current,
                    { id: "config-fresh", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 420, height: 320, metadata: { status: "loading" as const } },
                    { id: "node-fresh", type: CanvasNodeType.Image, title: "fresh", position: { x: 500, y: 0 }, width: 320, height: 180, metadata: { status: "loading" as const } },
                ];
                nodesRef.current = next;
                setNodesState(next);
                generationRef.current.startGenerationRequest("node-fresh", "config-fresh", "config-fresh", controller);
            },
            startFreshBatch() {
                // Same registration as a multi-image request: every child and the batch root belong to one controller.
                const controller = new AbortController();
                const child = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 600 }, width: 320, height: 180, metadata: { status: "loading", batchRootId: "batch-root" } });
                const next = [
                    ...nodesRef.current,
                    { id: "batch-root", type: CanvasNodeType.Image, title: "batch", position: { x: 0, y: 600 }, width: 320, height: 180, metadata: { status: "loading" as const, isBatchRoot: true, batchChildIds: ["batch-a", "batch-b"] } },
                    child("batch-a"),
                    child("batch-b"),
                ];
                nodesRef.current = next;
                setNodesState(next);
                ["batch-a", "batch-b", "batch-root"].forEach((id) => generationRef.current.startGenerationRequest(id, "config-batch", "config-batch", controller));
            },
            bindFreshTask() {
                const task: GenerationTask = { id: "fresh-task", type: "canvas_image", status: "running", projectId: projectIdRef.current, prompt: "fresh", attempts: 1, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" };
                generationRef.current.bindGenerationTask("node-fresh", task);
            },
            queueRecoveryAndBind() {
                // Parallel task listeners can queue a recovery update before
                // another listener binds its receipt in the same React batch.
                setNodes(current => current.map(node => node.id === "node-recovered" ? { ...node, metadata: { ...node.metadata, errorDetails: "恢复失败", taskStatus: "failed" } } : node));
                generationRef.current.bindGenerationTask("node-cached", { id: "receipt-task", projectId: "canvas-a", type: "canvas_image", status: "running", prompt: "receipt", attempts: 1, createdAt: "", updatedAt: "" });
            },
            switchProject(id) {
                const next = resetInterruptedGeneration(projectNodes[id] ?? []);
                setProjectLoaded(false);
                setProjectId(id);
                nodesRef.current = next;
                setNodesState(next);
                setTimeout(() => setProjectLoaded(true), 30);
            },
            unmount() {
                root.unmount();
            },
            snapshot() {
                return {
                    projectId: projectIdRef.current,
                    nodes: nodesRef.current,
                    freshAborted: freshControllerRef.current ? freshControllerRef.current.signal.aborted : null,
                    store: Object.fromEntries(useCanvasStore.getState().projects.map((project) => [project.id, project.nodes])),
                };
            },
        };
    }, [setNodes]);

    return <pre id="snapshot">{JSON.stringify({ projectId, projectLoaded, nodes })}</pre>;
}

root.render(
    <QueryClientProvider client={new QueryClient()}>
        <App>
            <Harness />
        </App>
    </QueryClientProvider>,
);
