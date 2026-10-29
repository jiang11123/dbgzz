import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import { getAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme, DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";
import { useState } from "react";
import { ChannelSettingsPane } from "@/pages/settings/channel-settings-pane";
import { ModelDefaultGrid } from "@/pages/settings/model-default-grid";
import { ChannelModelSettings } from "@/pages/settings/channel-model-settings";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal";
import { getClientDiagnosticEvents } from "@/services/diagnostics/client-diagnostics";
import { hydrateModelConfig } from "@/services/model-config-repository";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";

const config = normalizeConfigSnapshot({
    config: {
        ...defaultConfig,
        channels: [createModelChannel({ id: "studio", name: "工作室渠道", baseUrl: "https://api.example.com", apiKey: "synthetic-key", models: ["chat-x", "chat-z", "image-y", "image-z", "video-y", "video-z", "audio-y", "audio-z", "wand-vega-vl-1.0-flash"], modelProfiles: [
            { model: "wand-vega-vl-1.0-flash", capability: "text", protocol: "chat-completion" },
            { model: "chat-x", capability: "text", protocol: "chat-completion" },
            { model: "chat-z", capability: "text", protocol: "chat-completion" },
            { model: "image-y", capability: "image", protocol: "openai-image" },
            { model: "image-z", capability: "image", protocol: "openai-image" },
            { model: "video-y", capability: "video", protocol: "newapi" },
            { model: "video-z", capability: "video", protocol: "newapi" },
            { model: "audio-y", capability: "audio", protocol: "openai-audio" },
            { model: "audio-z", capability: "audio", protocol: "openai-audio" },
        ] })],
        imageModel: "studio::image-y",
        videoModel: "studio::video-y",
        textModel: "studio::chat-x",
        audioModel: "studio::audio-y",
        assistantModel: "studio::chat-x",
    },
}).config;
useConfigStore.getState().replaceConfig(config);

(window as unknown as { diagnostics: () => unknown }).diagnostics = () => getClientDiagnosticEvents();

function Harness() {
    const live = useConfigStore((state) => state.config);
    const [selected, setSelected] = useState(config);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [drawerSettled, setDrawerSettled] = useState(false);
    const [modalSettled, setModalSettled] = useState(false);
    const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
    const dark = new URLSearchParams(location.search).get("theme") === "dark";
    applySkinTheme(DEFAULT_CLASSIC_SKIN, dark ? "dark" : "light");
    return <ConfigProvider theme={getAntThemeConfig(dark, DEFAULT_CLASSIC_SKIN)}><App>
        <main style={{ padding: 20, maxWidth: 900 }}>
            <ChannelSettingsPane onOpenModels={() => {}} />
            <output data-testid="channel-count">{live.channels.length}</output>
            <ModelDefaultGrid config={selected} onChange={(key, model) => setSelected((current) => ({ ...current, [key]: model }))} />
            <output hidden data-testid="selected-models">{JSON.stringify(selected)}</output>
            <output hidden data-testid="overlay-motion-state" data-drawer-settled={drawerSettled} data-modal-settled={modalSettled} />
            <Button onClick={() => setCapabilitiesOpen(true)}>查看模型能力标签</Button>
            {capabilitiesOpen && <section data-testid="model-capabilities"><ChannelModelSettings draft channel={config.channels[0]!} onChange={() => {}} /></section>}
            <Button onClick={() => setDrawerOpen(true)}>打开验证侧栏</Button>
            <Button onClick={() => setModalOpen(true)}>打开验证弹窗</Button>
            <AppDrawer title="验证侧栏" open={drawerOpen} onClose={() => setDrawerOpen(false)} afterOpenChange={setDrawerSettled}>
                <ModelDefaultGrid config={selected} onChange={(key, model) => setSelected((current) => ({ ...current, [key]: model }))} />
                <Button onClick={() => setDrawerOpen(false)}>关闭验证侧栏</Button>
            </AppDrawer>
            <AppModal title="验证弹窗" open={modalOpen} onCancel={() => setModalOpen(false)} afterOpenChange={setModalSettled} footer={null}>
                <ModelDefaultGrid config={selected} onChange={(key, model) => setSelected((current) => ({ ...current, [key]: model }))} />
                <Button onClick={() => setModalOpen(false)}>关闭验证弹窗</Button>
            </AppModal>
        </main>
    </App></ConfigProvider>;
}
void hydrateModelConfig().then(() => createRoot(document.getElementById("root")!).render(<Harness />));
