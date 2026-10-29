import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasGeneration } from "../../src/pages/canvas/use-canvas-generation";
import { CanvasProjectStatusDialogs } from "../../src/pages/canvas/canvas-project-status-dialogs";
import type { GenerationTask } from "../../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";

const originalNodes: CanvasNodeData[] = [{ id: "node-original", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { taskId: "original", taskStatus: "failed", status: "error" } }];
await useCanvasStore.persist.rehydrate();
useCanvasStore.setState({ projects: [{ id: "canvas-a", title: "test", nodes: originalNodes, connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-01", updatedAt: "2026-10-01" }] });

function Harness() {
    const [projectId, setProjectId] = useState("canvas-a");
    const [nodes, setNodes] = useState<CanvasNodeData[]>(originalNodes);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    useEffect(() => { useCanvasStore.getState().updateProject(projectId, { nodes }); }, [nodes, projectId]);
    const generation = useCanvasGeneration({ projectId, projectLoaded: true, nodes, nodesRef, setNodes });
    const [hasId, setHasId] = useState(true);
    const task: GenerationTask = { id: "original", type: "canvas_video", status: "failed", providerRequestId: hasId ? "upstream-original" : undefined, prompt: "test", error: "视频下载中断", attempts: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
    return <>
        <button onClick={() => setProjectId("canvas-b")}>switch project</button>
        <button onClick={() => setHasId(false)}>missing receipt</button>
        <button onClick={() => { void generation.retrieveTaskResult(task); void generation.retrieveTaskResult(task); }}>double retrieve</button>
        <pre id="snapshot">{JSON.stringify({ projectId, nodes, retrieving: generation.retrievingTaskId })}</pre>
        <CanvasProjectStatusDialogs theme={{ node: { stroke: "gray", panel: "white", muted: "gray", fill: "white" } }} task={projectId === "canvas-a" ? task : null} taskLogs={[{ id: "log", level: "error", summary: "视频下载中断，请取回结果", createdAt: task.createdAt }]} taskLoading={false} onCloseTask={() => {}} onRetrieveTask={generation.retrieveTaskResult} retrievingTaskId={generation.retrievingTaskId} superResolveNode={null} onCloseSuperResolve={() => {}} onUseLocalUpscale={() => {}} previewNode={null} onClosePreview={() => {}} clearConfirmOpen={false} onCancelClear={() => {}} onConfirmClear={() => {}} />
    </>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><App><Harness /></App></QueryClientProvider>);
