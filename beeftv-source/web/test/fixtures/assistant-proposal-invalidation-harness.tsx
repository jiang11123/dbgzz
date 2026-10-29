import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "antd";
import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "@/lib/query-client";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { CanvasAssistantSidebar } from "@/pages/canvas/canvas-assistant-sidebar";
import { hydrateModelConfig } from "@/services/model-config-repository";
import "@/pages/canvas/canvas-assistant-sidebar.css";

await hydrateModelConfig();
function Harness() {
    const assistant = useCanvasAssistant({ canvasId: "proposal-test" });
    Object.assign(window, { proposalFixture: { refresh: assistant.reloadHistory } });
    return <App><div style={{ height: "100vh", display: "flex" }}>
        <CanvasAssistantSidebar assistant={assistant} canvasTitle="提案有效性测试" dockable readOnly={false} selectedNodeIds={[]} references={[]}
            onLocateNodes={() => {}} onRunProposal={() => { throw new Error("This fixture never submits generation"); }} onOpenModelSettings={() => {}} />
    </div></App>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={appQueryClient}><Harness /></QueryClientProvider></MemoryRouter>);
