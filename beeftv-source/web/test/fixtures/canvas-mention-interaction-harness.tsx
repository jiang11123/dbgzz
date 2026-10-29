import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "../../src/lib/query-client";
import { CanvasResourceMentionTextarea } from "../../src/components/canvas/canvas-resource-mention-textarea";
import { useAssetStore, type Asset } from "../../src/stores/use-asset-store";
import type { CanvasResourceReference } from "../../src/lib/canvas/canvas-resource-references";

const pixelDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
const audioDataUrl = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

const mockAssets: Asset[] = [
    {
        id: "asset-img-1",
        kind: "image",
        title: "IMG_5883.jpg",
        coverUrl: pixelDataUrl,
        category: "material",
        status: "confirmed",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: { dataUrl: pixelDataUrl, width: 100, height: 100, bytes: 100, mimeType: "image/jpeg" },
    },
    {
        id: "asset-img-5",
        kind: "image",
        title: "生成图片",
        coverUrl: pixelDataUrl,
        category: "material",
        status: "confirmed",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: { dataUrl: pixelDataUrl, width: 100, height: 100, bytes: 100, mimeType: "image/jpeg" },
    },
    {
        id: "asset-audio-1",
        kind: "audio",
        title: "音频",
        coverUrl: "",
        category: "material",
        status: "confirmed",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: { url: audioDataUrl, durationMs: 1000, bytes: 100, mimeType: "audio/wav" },
    },
    {
        id: "asset-char-1",
        kind: "entity",
        title: "角色主角",
        coverUrl: "",
        category: "character",
        status: "confirmed",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: { definition: {} },
    },
    {
        id: "asset-prop-1",
        kind: "image",
        title: "道具钥匙",
        coverUrl: pixelDataUrl,
        category: "prop",
        status: "confirmed",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: { dataUrl: pixelDataUrl, width: 100, height: 100, bytes: 100, mimeType: "image/jpeg" },
    },
];

useAssetStore.setState({ assets: mockAssets, hydrated: true });

const mockReferences: CanvasResourceReference[] = [
    {
        id: "ref-node-1",
        kind: "audio",
        label: "音频节点 1",
        title: "音频节点 1",
        nodeId: "node-1",
        active: true,
    },
    {
        id: "ref-node-2",
        kind: "text",
        label: "提示词节点 2",
        title: "提示词节点 2",
        nodeId: "node-2",
        active: true,
    },
    {
        id: "ref-skill-1",
        kind: "skill",
        label: "智能分镜技能",
        title: "智能分镜技能",
        active: true,
        skill: {
            skillId: "storyboard-auto",
            description: "根据剧本文本自动拆分分镜镜头",
            version: "1.0.0",
            fileCount: 4,
        },
    },
];

function TestApp() {
    const [richPrompt, setRichPrompt] = useState("");
    const [plainPrompt, setPlainPrompt] = useState("");
    const [underlyingClicks, setUnderlyingClicks] = useState(0);

    return (
        <div style={{ padding: "40px", maxWidth: "680px", margin: "0 auto", background: "#18181b", minHeight: "100vh", color: "#fff" }}>
            <div style={{ marginBottom: "16px", display: "flex", gap: "16px", alignItems: "center" }}>
                <span id="rich-prompt-display">RichPrompt: {richPrompt}</span>
                <span id="underlying-click-count">UnderlyingClicks: {underlyingClicks}</span>
            </div>

            {/* Rich Editor Section */}
            <div style={{ background: "#27272a", borderRadius: "8px", padding: "12px", minHeight: "100px", position: "relative" }}>
                <CanvasResourceMentionTextarea
                    id="rich-mention-input"
                    aria-label="rich-editor"
                    value={richPrompt}
                    references={mockReferences}
                    includeAssetLibrary
                    onChange={setRichPrompt}
                    onSelectReference={(ref) => ref}
                    placeholder="富文本输入框，可用 @ 引用"
                    style={{ width: "100%", height: "80px", color: "#fff", background: "transparent", border: "none", resize: "none" }}
                />
            </div>

            {/* Underlying target behind/near the menu to test ghost click */}
            <div style={{ margin: "16px 0" }}>
                <button
                    id="underlying-button"
                    type="button"
                    onClick={() => setUnderlyingClicks((prev) => prev + 1)}
                    style={{ padding: "8px 16px", background: "#3f3f46", border: "none", borderRadius: "4px", color: "#fff" }}
                >
                    底层测试按钮
                </button>
            </div>

            {/* Plain Textarea Section */}
            <div style={{ marginTop: "24px" }}>
                <div style={{ marginBottom: "8px" }}>
                    <span id="plain-prompt-display">PlainPrompt: {plainPrompt}</span>
                </div>
                <div style={{ background: "#27272a", borderRadius: "8px", padding: "12px", minHeight: "100px" }}>
                    <CanvasResourceMentionTextarea
                        id="plain-mention-input"
                    aria-label="secondary-editor"
                        value={plainPrompt}
                        references={mockReferences}
                        includeAssetLibrary
                        highlightLabels={false}
                        onChange={setPlainPrompt}
                        onSelectReference={(ref) => ref}
                        placeholder="纯原生 textarea 输入框"
                        style={{ width: "100%", height: "80px", color: "#fff", background: "transparent", border: "none", resize: "none" }}
                    />
                </div>
            </div>
        </div>
    );
}

const rootElement = document.getElementById("root");
if (rootElement) {
    createRoot(rootElement).render(<QueryClientProvider client={appQueryClient}><TestApp /></QueryClientProvider>);
}
