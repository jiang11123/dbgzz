import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { useEffect, useState } from "react";
import { App } from "antd";
import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "@/lib/query-client";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { CanvasAssistantSidebar } from "@/pages/canvas/canvas-assistant-sidebar";
import { hydrateModelConfig } from "@/services/model-config-repository";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { readAssistantInputDraft } from "@/services/assistant-attachments";
import { captureUserScope } from "@/lib/user-scope-guard";

await hydrateModelConfig();
function Harness() {
    const [visible, setVisible] = useState(true);
    const assistant = useCanvasAssistant({ canvasId: "production-test" });
    const [nodes, setNodes] = useState<CanvasNodeData[]>([{ id: "result", type: CanvasNodeType.Image, title: "雨夜街角首帧", position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { taskId: "task", taskClientOperationId: "proposal:p1:source", taskStatus: "running", status: "loading" } }]);
    useEffect(() => {
        assistant.markProposalHandled("p1");
        Object.assign(window, { productionFixture: {
            finish: () => setNodes(current => current.map(node => ({ ...node, metadata: { ...node.metadata, taskStatus: "succeeded", status: "success", storageKey: "resource:fixture" } }))),
            refresh: () => assistant.reloadHistory(),
            draft: () => readAssistantInputDraft("production-test", captureUserScope()),
            show: (next: boolean) => setVisible(next),
        } });
    }, []);
    return <App><div style={{ height: "100vh", display: "flex", justifyContent: "flex-end" }}>
        {visible ? <CanvasAssistantSidebar assistant={assistant} nodes={nodes} canvasTitle="双镜头创作验收（测试数据）" dockable readOnly={false} selectedNodeIds={["original"]} references={[]}
            onLocateNodes={() => {}} onRunProposal={() => {}} onOpenModelSettings={() => {}} /> : null}
    </div></App>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={appQueryClient}><Harness /></QueryClientProvider></MemoryRouter>);
