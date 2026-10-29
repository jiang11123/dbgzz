import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { App } from "antd";
import { AgentConnectPanel } from "@/pages/agents/agent-connect-panel";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { CanvasAssistantSidebar } from "@/pages/canvas/canvas-assistant-sidebar";
import { configureApiRuntime } from "@/services/api/request";
import { hydrateModelConfig } from "@/services/model-config-repository";
import { resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import { useAssetStore } from "@/stores/use-asset-store";
import { captureUserScope } from "@/lib/user-scope-guard";
import { setActiveUserScope } from "@/lib/user-scope";
import { appQueryClient } from "@/lib/query-client";
import { assetLibraryQueryKey } from "@/components/assets/asset-view-session";
import { isNativeDesktopRuntime } from "@/lib/runtime-mode";
import { readAssistantInputDraft } from "@/services/assistant-attachments";
import "@/pages/canvas/canvas-assistant-sidebar.css";

configureApiRuntime(location.origin + "/api", "synthetic-desktop-preview");
await hydrateModelConfig();
const initialAssetQuery = assetLibraryQueryKey(captureUserScope(), "fixture");
const changedCanvases: string[] = [], locatedNodes: string[][] = [];
appQueryClient.setQueryData(initialAssetQuery, { total: 0 });
Object.assign(window, { assistantInputFixture: {
    assets: () => useAssetStore.getState().assets.map(asset => ({ id: asset.id, title: asset.title, kind: asset.kind, data: asset.data })),
    draft: () => readAssistantInputDraft("input-canvas", captureUserScope()),
    nativeLocal: isNativeDesktopRuntime,
    libraryInvalidated: () => appQueryClient.getQueryState(initialAssetQuery)?.isInvalidated,
    changedCanvases: () => [...changedCanvases],
    locatedNodes: () => [...locatedNodes],
    switchScope: async (scope = "other-workspace") => { await fetch("/test/asset-scope", { method: "POST", body: JSON.stringify({ scope }) }); setActiveUserScope(scope); useAssetStore.setState({ assets: [] }); },
} });
function Harness() {
    const [externalOpen, setExternalOpen] = useState(false);
    const assistant = useCanvasAssistant({ canvasId: "input-canvas", onCanvasChanged: canvasId => { changedCanvases.push(canvasId); } });
    return <App><div style={{ height: "100vh", width: "100%", display: "flex" }}><CanvasAssistantSidebar assistant={assistant} canvasTitle="附件流程验证" dockable readOnly={false}
        selectedNodeIds={[]} references={[{ id: "node:n1", nodeId: "n1", kind: "image", label: "画布人像", title: "画布人像", active: true, storageKey: resourceStorageKey("existing"), previewUrl: resourceFileUrl("existing") }]}
        onLocateNodes={nodeIds => { locatedNodes.push(nodeIds); }} onRunProposal={() => {}} onOpenModelSettings={() => {}} /></div>
        <button style={{ position: "fixed", left: 4, top: 4 }} onClick={() => setExternalOpen(true)}>连接外部 Agent</button>
        {externalOpen ? <AgentConnectPanel kind="codex" onClose={() => setExternalOpen(false)} onConfigured={() => {}} verifiedClientIds={[]} onBusyChange={() => {}} /> : null}
    </App>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={appQueryClient}><Harness /></QueryClientProvider></MemoryRouter>);
