import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasVideoPromptTools } from "../../src/components/canvas/canvas-video-prompt-tools";
import { buildVideoGenerationMetadata } from "../../src/lib/canvas/canvas-project-generation";
import { h3MediaPayload } from "@/lib/h3-video";
import { defaultConfig } from "../../src/stores/use-config-store";
import { useCanvasThemeStore } from "../../src/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeMetadata } from "../../src/types/canvas";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
useCanvasThemeStore.setState({ active: true, theme: dark ? "dark" : "light" });
const media = ["first", "last", "middle"].map((id) => ({ id, type: "image" as const, url: `https://example.test/${id}.png` }));
const frameOptions = [
    { nodeId: "first", label: "图片 1", title: "首帧图片" },
    { nodeId: "last", label: "图片 2", title: "尾帧图片" },
    { nodeId: "middle", label: "图片 3", title: "中间图片" },
];

function Harness() {
    const [metadata, setMetadata] = useState<CanvasNodeMetadata>({ videoStartFrameNodeId: "first", videoEndFrameNodeId: "last" });
    const [includeMiddle, setIncludeMiddle] = useState(true);
    const [result, setResult] = useState<unknown>();
    const buildRequest = () => {
        try {
            const references = includeMiddle ? media : media.slice(0, 2);
            const options = buildVideoGenerationMetadata(
                { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 240, metadata },
                { referenceImages: references.map((item) => ({ ...item, dataUrl: item.url })), referenceVideos: [], referenceAudios: [] },
                { ...defaultConfig, model: "minimax-h3-max" },
            );
            setResult(h3MediaPayload("minimax-h3-max", references, options, 5, "768p"));
        } catch (error) { setResult({ error: error instanceof Error ? error.message : String(error) }); }
    };
    return <main className="mx-auto mt-12 w-full max-w-md p-4 text-foreground">
        <section data-testid="controls" className="rounded-lg border border-border p-4">
            <h1 className="mb-4 text-base font-semibold">H3 Max 关键帧</h1>
            <CanvasVideoPromptTools metadata={metadata} frameOptions={frameOptions} middleFrameSupported onMetadataChange={(patch) => setMetadata((current) => ({ ...current, ...patch }))} />
        </section>
        <div className="my-4 flex gap-3">
            <button onClick={buildRequest}>验证请求参数</button>
            <button onClick={() => setIncludeMiddle(false)}>断开中间图片</button>
        </div>
        <output data-testid="metadata">{JSON.stringify(metadata)}</output>
        <output data-testid="payload">{JSON.stringify(result)}</output>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
