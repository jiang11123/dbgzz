import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";

import { useCanvasNodeEditor } from "../../src/pages/canvas/use-canvas-node-editor";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

type EnsureCall = {
    source?: string;
    category?: string;
    canvasId?: string;
    nodeId?: string;
    hasExpectedScope: boolean;
    hasSignal: boolean;
};

type HarnessWindow = Window & {
    __editorHarness?: {
        writes: string[];
        toasts: string[];
        ensureCalls: EnsureCall[];
        switchABA: () => Promise<void>;
        switchCanvas: () => void;
    };
};

const harnessWindow = window as HarnessWindow;

setActiveUserScope("owner-a");

function recordToast(node: Node) {
    const text = node.textContent?.trim();
    if (text) harnessWindow.__editorHarness!.toasts.push(text);
}

function watchToasts() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.classList.contains("ant-message-notice") || node.querySelector?.(".ant-message-notice")) {
                    recordToast(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function imageNode(assetId?: string): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Image,
        title: "节点",
        position: { x: 0, y: 0 },
        width: 8,
        height: 8,
        metadata: { content: "data:image/png;base64,xx", assetId },
    };
}

harnessWindow.__editorHarness = {
    writes: [],
    toasts: [],
    ensureCalls: [],
    switchABA: async () => {},
    switchCanvas: () => {},
};

function createHarnessQueryClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((...args: Parameters<typeof original>) => {
        harnessWindow.__editorHarness!.writes.push("invalidate");
        return original(...args);
    }) as typeof client.invalidateQueries;
    return client;
}

function Harness() {
    const [canvasId, setCanvasId] = useState("canvas-a");
    const [, setTick] = useState(0);
    const [nodes, setNodesState] = useState<CanvasNodeData[]>([imageNode()]);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;

    const setNodes: Dispatch<SetStateAction<CanvasNodeData[]>> = (value) => {
        harnessWindow.__editorHarness!.writes.push("setNodes");
        setNodesState((current) => (typeof value === "function" ? value(current) : value));
    };

    const editor = useCanvasNodeEditor({
        canvasId,
        canvasTitle: "画布",
        domainProjectId: "project-a",
        nodesRef,
        setNodes,
        setSelectedNodeIds: () => {},
        setSelectedConnectionId: () => {},
        setDialogNodeId: () => {},
        setToolbarNodeId: () => {},
        setHoveredNodeId: () => {},
    });

    harnessWindow.__editorHarness!.switchABA = async () => {
        await fetch("/harness/switch", { method: "POST" });
        setActiveUserScope("owner-b");
        setActiveUserScope("owner-a");
        setTick((value) => value + 1);
    };
    harnessWindow.__editorHarness!.switchCanvas = () => {
        setCanvasId("canvas-b");
    };

    return (
        <>
            <div style={{ position: "fixed", top: 0, left: 0, zIndex: 11000, display: "flex", gap: 8, padding: 8 }}>
                <button type="button" onClick={() => void harnessWindow.__editorHarness!.switchABA()}>switch-aba</button>
                <button type="button" onClick={() => harnessWindow.__editorHarness!.switchCanvas()}>switch-canvas</button>
                <button type="button" onClick={() => editor.handleConfigNodeChange("node-1", { assetCategory: "character" })}>set-category</button>
                <button type="button" onClick={() => void editor.saveNodeAsset(nodesRef.current[0]!)}>save-asset</button>
            </div>
            <main style={{ padding: 48 }}>
                <p data-testid="canvas-id">{canvasId}</p>
                <p data-testid="node-asset">{String(nodes[0]?.metadata?.assetId || "none")}</p>
                <p data-testid="node-category">{String(nodes[0]?.metadata?.assetCategory || "none")}</p>
            </main>
        </>
    );
}

watchToasts();
createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={createHarnessQueryClient()}>
        <App>
            <Harness />
        </App>
    </QueryClientProvider>,
);
