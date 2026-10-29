import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasGeneration } from "../../src/pages/canvas/use-canvas-generation";
import { useCanvasStoryboard } from "../../src/pages/canvas/use-canvas-storyboard";
import { resetInterruptedGeneration } from "../../src/lib/canvas/canvas-project-generation";
import { useConfigStore } from "../../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

// Drives the real storyboard request next to the real useCanvasGeneration, so a
// later remote copy goes through the same restore and late recovery path the
// project lifecycle uses while the storyboard request is still in flight.

useConfigStore.setState({ isAiConfigReady: () => true });

const initialNodes: CanvasNodeData[] = [
    { id: "style", type: CanvasNodeType.Text, title: "画风", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { workflowKind: "styleboard", content: "写实电影感", stylePresetId: "cinematic" } },
    { id: "script", type: CanvasNodeType.Script, title: "分镜", position: { x: 400, y: 0 }, width: 640, height: 420, metadata: { status: "idle" } },
];

type StoryboardHarness = {
    generate(): void;
    remoteLoad(extra: CanvasNodeData[]): void;
    takeOver(): void;
    snapshot(): { nodes: CanvasNodeData[]; settled: boolean | undefined | "pending" };
};
declare global {
    interface Window {
        storyboardHarness?: StoryboardHarness;
    }
}

const noop = () => {};

function Harness() {
    const nodesRef = useRef<CanvasNodeData[]>(initialNodes);
    const connectionsRef = useRef([]);
    const [nodes, setNodesState] = useState<CanvasNodeData[]>(initialNodes);
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
    const generation = useCanvasGeneration({ projectId: "canvas-a", projectLoaded: true, nodes, nodesRef, setNodes });
    const storyboard = useCanvasStoryboard({
        projectId: "canvas-a",
        addedSkills: [],
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections: noop,
        setSelectedNodeIds: noop,
        enqueueGenerationBatch: () => undefined,
        startGenerationRequest: generation.startGenerationRequest,
        finishGenerationRequest: generation.finishGenerationRequest,
    });
    const latest = useRef({ generation, storyboard });
    latest.current = { generation, storyboard };
    const settledRef = useRef<boolean | undefined | "pending">(undefined);

    useEffect(() => {
        window.storyboardHarness = {
            generate() {
                settledRef.current = "pending";
                void latest.current.storyboard.generateScriptRows("script", "拆分镜头").then((result) => { settledRef.current = result ?? undefined; });
            },
            remoteLoad(extra) {
                // Remote copy = the live graph the client already autosaved plus nodes this client never saw.
                const restored = resetInterruptedGeneration([...nodesRef.current.filter((node) => !extra.some((item) => item.id === node.id)), ...extra]);
                nodesRef.current = restored;
                setNodesState(restored);
            },
            takeOver() {
                // Another generation path claims the script node through the shared request registry.
                latest.current.generation.startGenerationRequest("script", "script", "script");
                setNodes((current) => current.map((node) => (node.id === "script" ? { ...node, metadata: { ...node.metadata, status: "loading", taskStage: "接管" } } : node)));
            },
            snapshot() {
                return { nodes: nodesRef.current, settled: settledRef.current };
            },
        };
    }, [setNodes]);

    return <pre id="snapshot">{JSON.stringify(nodes)}</pre>;
}

createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={new QueryClient()}>
        <App>
            <Harness />
        </App>
    </QueryClientProvider>,
);
