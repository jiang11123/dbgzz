import { createRef, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import { useCanvasGenerationOrchestration } from "../../src/pages/canvas/use-canvas-generation-orchestration";
import { useCanvasResourceHandoff } from "../../src/pages/canvas/use-canvas-resource-handoff";
import { queryGenerationTask } from "../../src/services/api/task-center";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const noop = () => {};

function Harness() {
    const [projectId, setProjectId] = useState("canvas-test");
    const [, refresh] = useState(0);
    const [nodes, setNodes] = useState<CanvasNodeData[]>([{ id: "node-test", type: CanvasNodeType.Video, title: "取回测试", position: { x: 0, y: 0 }, width: 560, height: 320, metadata: { status: "loading", taskId: "task-test", taskStatus: "succeeded", content: location.search.includes("old") ? "data:video/mp4;base64,AA==" : undefined } }]);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectionsRef = useRef([]);
    const generation = useCanvasGenerationOrchestration({ projectId, projectLoaded: false, localOnly: true, addedSkills: [], assets: [], nodes, connections: [], nodesRef, connectionsRef, setNodes, setConnections: noop, setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop, setGenerationHistoryOpen: noop, getCanvasCenter: () => ({ x: 0, y: 0 }) });
    // Applying a fully downloaded asset is outside this test. Keep the actual
    // resume hook and task metadata projection, then stop at resumed delivery.
    const handoff = useCanvasResourceHandoff({ projectId, linkedProjectId: "", projectLoaded: false, assets: [], assetsHydrated: false, nodesRef, searchParams: new URLSearchParams(), setSearchParams: noop, setNodes, getCanvasCenter: () => ({ x: 0, y: 0 }), createHandoffNodes: async () => [], applyGenerationTaskResult: async (id, task) => { generation.bindGenerationTask(id, task); }, startGenerationRequest: generation.startGenerationRequest, finishGenerationRequest: generation.finishGenerationRequest });
    // Another generation path claims the same node through the shared request registry.
    const takeOver = () => {
        generation.startGenerationRequest("node-test", "node-test", "node-test");
        setNodes((current) => current.map((node) => ({ ...node, metadata: { ...node.metadata, status: "loading", taskStage: "接管" } })));
    };
    return <>
        <button id="take-over" onClick={takeOver}>接管节点</button>
        <button id="switch-canvas" onClick={() => setProjectId("canvas-other")}>切换画布</button>
        <button id="switch-account" onClick={() => { setActiveUserScope("other"); refresh((value) => value + 1); }}>切换账号</button>
        <div style={{ width: 560, height: 320 }}>
            <CanvasNodeContent node={nodes[0]} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={noop} onStopEditing={noop} mentionReferences={[]} onCancelTask={async () => generation.cancelCanvasTask(await queryGenerationTask("task-test"))} onReloadResource={handoff.reloadCanvasNodeResource} />
        </div>
        <pre id="snapshot">{JSON.stringify({ projectId, nodes })}</pre>
    </>;
}

createRoot(document.getElementById("root")!).render(<ConfigProvider><App><QueryClientProvider client={client}><Harness /></QueryClientProvider></App></ConfigProvider>);
