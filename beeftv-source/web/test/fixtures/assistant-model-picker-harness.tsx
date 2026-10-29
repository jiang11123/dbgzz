import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { CanvasAssistantModelPicker } from "@/pages/canvas/canvas-assistant-model-picker";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { commitModelConfig, hydrateModelConfig } from "@/services/model-config-repository";
import { useConfigStore } from "@/stores/use-config-store";
import { ChannelSettingsPane } from "@/pages/settings/channel-settings-pane";
import { ModelDefaultGrid } from "@/pages/settings/model-default-grid";
import "@/pages/canvas/canvas-assistant-sidebar.css";

const result = await hydrateModelConfig();
useConfigStore.getState().replaceConfig(result.config);
useConfigStore.subscribe(state => { void commitModelConfig(state.config); });
function Harness() {
    const [busy, setBusy] = useState(false);
    const [dark, setDark] = useState(false);
    const assistant = useCanvasAssistant({ canvasId: "c1", onCanvasChanged: () => {} });
    const config = useConfigStore((state) => state.config);
    if (location.pathname === "/defaults") return <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}><App>
        <ModelDefaultGrid config={config} onChange={(key, value) => useConfigStore.getState().updateConfig(key, value)} />
    </App></ConfigProvider>;
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App>
        <main style={{ width: "100%", maxWidth: 380, background: dark ? "#141414" : "#fff" }}>
            {location.pathname === "/settings" ? <ChannelSettingsPane onOpenModels={() => {}} onOpenRunningHub={() => {}} /> : null}
            <div className="canvas-assistant-composer-footer"><CanvasAssistantModelPicker busy={busy || assistant.modelBusy} /><button onClick={() => void assistant.send("synthetic", [])}>发送测试消息</button></div>
            <button onClick={() => setBusy(!busy)}>切换忙碌</button><button onClick={() => setDark(!dark)}>切换主题</button>
            <output>{assistant.error || ""}</output>
        </main>
    </App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
