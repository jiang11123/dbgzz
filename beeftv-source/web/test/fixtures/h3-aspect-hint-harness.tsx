import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { CanvasNodePromptPanel } from "../../src/components/canvas/canvas-node-prompt-panel";
import { appQueryClient } from "../../src/lib/query-client";
import type { CanvasResourceReference } from "../../src/lib/canvas/canvas-resource-references";
import { useConfigStore } from "../../src/stores/use-config-store";
import { useCanvasThemeStore } from "../../src/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import { h3AspectConfig, h3Models, h3StyleModels } from "./h3-aspect-config";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
useCanvasThemeStore.setState({ active: true, theme: dark ? "dark" : "light" });
useConfigStore.getState().replaceConfig(h3AspectConfig());
const image: CanvasResourceReference = { id: "fixture-image", nodeId: "frame", kind: "image", label: "图片1", title: "横屏首帧", active: true, previewUrl: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#87928f"/></svg>') };

function Harness() {
    const [references, setReferences] = useState<CanvasResourceReference[]>([image]);
    const character: CanvasResourceReference = { ...image, id: "character", nodeId: "character", kind: "character", label: "角色1", title: "角色卡封面" };
    const [node, setNode] = useState<CanvasNodeData>({ id: "video", type: CanvasNodeType.Video, title: "视频生成", position: { x: 0, y: 0 }, width: 360, height: 260, metadata: { model: "beefapi::minimax-h3-max-turbo", composerContent: "人物走向镜头", size: "9:16", vquality: "768p", seconds: "15" } });
    return <main style={{ padding: 16, maxWidth: 430, margin: "48px auto" }}>
        <nav aria-label="验证场景" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {h3Models.map((model) => <button key={model} onClick={() => setNode((current) => ({ ...current, metadata: { ...current.metadata, model: `beefapi::${model}` } }))}>{model}</button>)}
            <button onClick={() => setNode((current) => ({ ...current, metadata: { ...current.metadata, model: `beefapi::${h3StyleModels[0]}` } }))}>H3 手绘</button>
            <button onClick={() => { setReferences(references.length ? [] : [image]); setNode((current) => ({ ...current, metadata: { ...current.metadata, videoStartFrameNodeId: undefined, videoEndFrameNodeId: undefined, videoEditOperation: undefined } })); }}>{references.length ? "断开图片" : "接入图片"}</button>
            <button onClick={() => setNode((current) => ({ ...current, metadata: { ...current.metadata, videoStartFrameNodeId: "frame", videoEndFrameNodeId: undefined } }))}>指定首帧</button>
            <button onClick={() => setNode((current) => ({ ...current, metadata: { ...current.metadata, videoStartFrameNodeId: undefined, videoEndFrameNodeId: "frame" } }))}>只用尾帧</button>
            <button onClick={() => setNode((current) => ({ ...current, metadata: { ...current.metadata, videoStartFrameNodeId: "frame", videoEndFrameNodeId: "frame" } }))}>首尾帧</button>
            <button onClick={() => setNode((current) => ({ ...current, metadata: { ...current.metadata, videoStartFrameNodeId: undefined, videoEndFrameNodeId: undefined, videoEditOperation: "reference_to_video" } }))}>普通参考</button>
            <button onClick={() => setReferences([image, character])}>加入角色卡</button>
            <button onClick={() => { setReferences([character]); setNode((current) => ({ ...current, metadata: { ...current.metadata, videoStartFrameNodeId: undefined, videoEndFrameNodeId: undefined, videoEditOperation: undefined } })); }}>仅角色卡</button>
        </nav>
        <section data-testid="product-panel" style={{ position: "relative" }}>
            <CanvasNodePromptPanel projectId="fixture-project" node={node} isRunning={false} mentionReferences={references} onPromptChange={(_id, composerContent) => setNode((current) => ({ ...current, metadata: { ...current.metadata, composerContent } }))} onConfigChange={(_id, patch) => setNode((current) => ({ ...current, metadata: { ...current.metadata, ...patch } }))} onGenerate={() => {}} onRemoveReference={() => setReferences([])} />
        </section>
        <output hidden data-testid="saved-size">{node.metadata?.size}</output>
        <output hidden data-testid="saved-seed">{node.metadata?.videoH3Options?.seed}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter><QueryClientProvider client={appQueryClient}><Harness /></QueryClientProvider></MemoryRouter></App></ConfigProvider>);
