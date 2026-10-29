import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasNodeOperations } from "../../src/pages/canvas/use-canvas-node-operations";
import { CanvasVersionHistory, useCanvasVersionHistory } from "../../src/pages/canvas/canvas-version-history";
import { HistoryTaskCard } from "../../src/components/canvas/canvas-generation-history-picker";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { preserveCanvasSyncDraft } from "../../src/services/canvas-sync-drafts";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import type { CanvasProject } from "../../src/stores/canvas/use-canvas-store";
import type { GenerationTask } from "../../src/services/api/task-center";
import { MemoryRouter } from "react-router";
import SettingsPage from "../../src/pages/settings";

const harness = (window as any).__repairHarness = { deleted: [], destroyed: 0, confirmation: null, downloads: [], restored: [] };
setActiveUserScope("owner-a");
const useApp = App.useApp;
App.useApp = () => {
    const app = useApp();
    return { ...app, modal: { ...app.modal, confirm: (options: any) => {
        harness.confirmation = options;
        const result = app.modal.confirm(options);
        return { ...result, destroy: () => { harness.destroyed++; result.destroy(); } };
    } } };
};

function node(taskId: string): CanvasNodeData {
    return { id: "shared-node", type: CanvasNodeType.Image, title: taskId, position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { taskId, taskStatus: "running", status: "loading" } };
}
function project(nodes: CanvasNodeData[]): CanvasProject {
    return { id: "canvas-a", title: "画布", nodes, connections: [], createdAt: "2026-10-10", updatedAt: "2026-10-10", revision: 2 };
}
function Editor() {
    const [projectId, setProjectId] = useState("canvas-a");
    const [nodes, setNodes] = useState([node("task-a")]);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectionsRef = useRef([]);
    const selectedNodeIdsRef = useRef(new Set<string>());
    const ops = useCanvasNodeOperations({ projectId, nodesRef, connectionsRef, selectedNodeIdsRef, defaultDrawingEngine: "excalidraw",
        getCanvasCenter: () => ({ x: 0, y: 0 }), setNodes, setConnections: () => {}, setSelectedNodeIds: () => {},
        setSelectedConnectionId: () => {}, setContextMenu: () => {}, setDialogNodeId: () => {},
        onNodesDeleted: (_ids, _next, removed) => harness.deleted.push({ projectId, tasks: removed.map(item => item.metadata?.taskId) }) });
    harness.switchCanvas = () => { setProjectId(value => value === "canvas-a" ? "canvas-b" : "canvas-a"); setNodes([node("task-b")]); };
    harness.switchScope = () => { setActiveUserScope("owner-b"); setActiveUserScope("owner-a"); };
    return <><button onClick={() => ops.deleteNodes(new Set(["shared-node"]))}>delete-node</button><output data-testid="nodes">{nodes.map(item => item.metadata?.taskId).join(",")}</output><output data-testid="canvas">{projectId}</output></>;
}
function Versions() {
    const current = project([node("current")]);
    const history = useCanvasVersionHistory("canvas-a", async id => { harness.restored.push(id); }, current);
    harness.seedDraft = async () => { await preserveCanvasSyncDraft(project([node("old-draft")])); };
    return <><button onClick={history.show}>open-versions</button><div style={{ height: 500, width: "100%" }}><CanvasVersionHistory history={{ ...history, desktop: true }} /></div></>;
}
const tasks = Array.from({ length: 100 }, (_, index): GenerationTask => ({ id: `video-${index}`, projectId: "canvas-a", type: "canvas_video", status: "succeeded",
    prompt: `视频 ${index}`, previewKind: "video", attempts: 1, createdAt: "2026-10-10", updatedAt: "2026-10-10" }));
function Harness() {
    const [mounted, setMounted] = useState(true);
    const [active, setActive] = useState(true);
    harness.unmountEditor = () => setMounted(false);
    harness.closeHistory = () => setActive(false);
    const mode = new URLSearchParams(location.search).get("mode");
    if (mode === "diagnostics") return <MemoryRouter initialEntries={[`/settings${location.search}`]}><SettingsPage /></MemoryRouter>;
    return mode === "versions" ? <Versions /> : mode === "videos" ? <div>{tasks.map(task => <div key={task.id} style={{ width: 142, height: 100 }}><HistoryTaskCard task={task} active={active} selecting={false} onSelect={() => {}} /></div>)}</div> : mounted ? <Editor /> : <p>unmounted</p>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App><Harness /></App></QueryClientProvider>);
