import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../src/styles/globals.css";
import { CanvasNodePromptPanel } from "../../src/components/canvas/canvas-node-prompt-panel";
import { createModelChannel, defaultConfig, useConfigStore } from "../../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../../src/lib/model-capabilities";
import { H3_STYLES } from "../../src/lib/h3-video";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../../src/types/canvas";
import type { CanvasResourceReference } from "../../src/lib/canvas/canvas-resource-references";
import { useCanvasThemeStore } from "../../src/stores/canvas/use-canvas-theme-store";

const light = new URLSearchParams(location.search).get("theme") === "light";
document.documentElement.classList.toggle("dark", !light);
useCanvasThemeStore.setState({ active: true, theme: light ? "light" : "dark" });

const models = ["minimax-h3", "minimax-h3-max", "minimax-h3-max-turbo", ...Object.keys(H3_STYLES), "seedance-2.5"];
const channel = createModelChannel({ id: "h3-entry", name: "入口验收", scope: "system", baseUrl: "https://example.invalid/v1", apiKey: "synthetic-ui-test-key", interfaceType: "newapi", models });
channel.modelProfiles = models.map((model) => {
    const capabilityConfig = defaultModelCapabilityConfig("newapi", model);
    if (model.startsWith("minimax-h3")) {
        const continuous = model === "minimax-h3-max" || model === "minimax-h3-max-turbo";
        const style = model.includes("style-");
        capabilityConfig.video = { ...capabilityConfig.video!, duration: { selection: "range", min: continuous ? 1 : 5, max: 15, step: 1, default: 5, ...(continuous ? { fractionalMin: 0.92, continuous: true } : {}) }, resolutions: style ? ["768p"] : continuous ? ["480p", "768p", "1080p"] : ["480p", "768p", "2k", "4k"], defaultResolution: "768p", operations: style ? ["text_to_video", "image_to_video"] : ["text_to_video", "image_to_video", "reference_to_video", "audio_to_video"], references: { ...capabilityConfig.video!.references, maxImages: style ? 1 : 9, maxVideos: style ? 0 : 3, maxAudios: style ? 0 : 3 } };
    }
    return { model, displayName: model, capability: "video", protocol: "newapi", billingMode: "per_second", unitPriceMicrocredits: 0, capabilityConfig };
});
useConfigStore.setState({ config: { ...defaultConfig, channels: [channel], model: "h3-entry::minimax-h3-max", videoModel: "h3-entry::minimax-h3-max", videoSeconds: "5", vquality: "768p", size: "16:9" }, isAiConfigReady: true });

const allReferences: CanvasResourceReference[] = [
    { id: "start", nodeId: "start", kind: "image", label: "图片1", title: "花园首帧", active: true },
    { id: "end", nodeId: "end", kind: "image", label: "图片2", title: "花园尾帧", active: true },
    { id: "middle", nodeId: "middle", kind: "image", label: "图片3", title: "花园中间帧", active: true },
    { id: "video", nodeId: "video", kind: "video", label: "视频1", title: "运镜参考", active: true },
    { id: "audio", nodeId: "audio", kind: "audio", label: "音频1", title: "鸟鸣参考", active: true },
];

function Harness() {
    const [metadata, setMetadata] = useState<CanvasNodeMetadata>({ generationMode: "video", model: "h3-entry::minimax-h3-max", seconds: "0.925", prompt: "花园里的一束光", videoH3Options: { seed: 0, enable_safety_checker: false } });
    const [referenceSet, setReferenceSet] = useState("none");
    const references = referenceSet === "all" ? allReferences : referenceSet === "audio" ? allReferences.slice(-1) : [];
    const patch = (_id: string, value: Partial<CanvasNodeMetadata>) => setMetadata((current) => ({ ...current, ...value }));
    const node: CanvasNodeData = { id: "video-node", type: CanvasNodeType.Video, title: "普通视频节点", position: { x: 0, y: 0 }, width: 460, height: 280, metadata };
    return (
        <main className="mx-auto flex w-full max-w-xl flex-col gap-3 p-4 text-foreground">
            <h1 className="text-lg font-semibold">普通视频节点入口回验</h1>
            <p className="text-xs opacity-65">挂载产品提示词面板；不发起付费生成。</p>
            <label className="text-xs">参考素材 <select aria-label="验收参考素材" value={referenceSet} onChange={(event) => setReferenceSet(event.target.value)}><option value="none">无</option><option value="all">图片、视频、音频</option><option value="audio">仅音频</option></select></label>
            <CanvasNodePromptPanel projectId="h3-entry-test" node={node} isRunning={false} onPromptChange={(id, prompt) => patch(id, { prompt })} onConfigChange={patch} onGenerate={() => { throw new Error("验收夹具禁止生成"); }} mentionReferences={references} />
            <output id="h3-entry-state" className="break-all text-xs">{JSON.stringify(metadata)}</output>
        </main>
    );
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ConfigProvider theme={{ algorithm: light ? theme.defaultAlgorithm : theme.darkAlgorithm }}><App><Harness /></App></ConfigProvider></QueryClientProvider></MemoryRouter>);
