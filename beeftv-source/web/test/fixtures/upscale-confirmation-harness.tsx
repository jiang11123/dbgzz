import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { UpscaleNodeContent } from "../../src/components/canvas/nodes/upscale-node";
import { CanvasNodeGraphContext } from "@/components/canvas/canvas-node-graph-context";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { useCanvasUpscaleBatch } from "../../src/pages/canvas/use-canvas-upscale-batch";
import { createDefaultUpscaleSettings } from "../../src/lib/canvas/canvas-upscale";
import { canvasThemes } from "@/lib/canvas-theme";
import { setActiveUserScope } from "@/lib/user-scope";
import { createModelChannel, useConfigStore } from "../../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../../src/types/canvas";

setActiveUserScope("upscale-confirmation-test");
useConfigStore.setState(state => ({ config: { ...state.config, channels: [createModelChannel({ id: "beefapi", pinned: true, enabled: true, credentialRef: "beefapi-enterprise", baseUrl: "https://enterprise.beefapi.com", models: [] })] } }));

function Harness() {
    const [nodes, setNodes] = useState<CanvasNodeData[]>([
        { id: "source", title: "原图", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "success", storageKey: "resource:owned-source", naturalWidth: 100, naturalHeight: 100 } },
        { id: "processor", type: CanvasNodeType.Upscale, position: { x: 200, y: 0 }, width: 360, height: 200, metadata: { upscale: createDefaultUpscaleSettings() } },
    ]);
    const [connections, setConnections] = useState<CanvasConnection[]>([{ id: "edge", fromNodeId: "source", toNodeId: "processor" }]);
    const [error, setError] = useState("");
    const [observed, setObserved] = useState("");
    const nodesRef = useRef(nodes); nodesRef.current = nodes;
    const connectionsRef = useRef(connections); connectionsRef.current = connections;
    const { startUpscaleBatch } = useCanvasUpscaleBatch({ projectId: "upscale-canvas", nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds: () => {}, prepareResource: async () => "owned-source", observeTask: task => setObserved(task.id) });
    const processor = nodes.find(node => node.id === "processor")!;
    return <>
        <CanvasNodeGraphContext.Provider value={{ getUpstreamNodes: () => [nodes[0]], getNode: id => nodes.find(node => node.id === id) }}>
            <CanvasNodeActionContext.Provider value={{ updateMetadata: (id, patch) => setNodes(current => current.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, ...patch } } : node)), startUpscaleBatch: async node => { try { await startUpscaleBatch(node); } catch (cause) { setError(String(cause)); } } }}>
                <div style={{ width: 360, height: 200, position: "relative" }}><UpscaleNodeContent node={processor} theme={canvasThemes.light} /></div>
            </CanvasNodeActionContext.Provider>
        </CanvasNodeGraphContext.Provider>
        <pre id="snapshot" style={{ marginTop: 700 }}>{JSON.stringify({ nodes, observed, error })}</pre>
    </>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><Harness /></App></ConfigProvider>);
