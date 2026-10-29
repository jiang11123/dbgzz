import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import "../../src/styles/globals.css";
import { CanvasH3Controls } from "../../src/components/canvas/canvas-h3-controls";
import { CanvasH3ReferenceOrder } from "../../src/components/canvas/canvas-h3-reference-order";
import { CanvasVideoPromptTools } from "../../src/components/canvas/canvas-video-prompt-tools";
import type { CanvasNodeMetadata } from "../../src/types/canvas";
import type { H3VideoOptions } from "../../src/lib/h3-video";

function Harness() {
    const [model, setModel] = useState("minimax-h3-max"),
        [duration, setDuration] = useState("0.925"),
        [options, setOptions] = useState<H3VideoOptions>({ seed: 0, enable_safety_checker: false }),
        [metadata, setMetadata] = useState<CanvasNodeMetadata>({ videoEditOperation: "reference_to_video" });
    const patch = (p: Partial<CanvasNodeMetadata>) => setMetadata((v) => ({ ...v, ...p }));
    return (
        <main className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 text-foreground">
            <h1 className="text-lg font-semibold">H3 生成设置</h1>
            <label>
                模型
                <select aria-label="测试模型" className="ml-2 rounded border px-2 py-1" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="minimax-h3-max">H3 Max</option>
                    <option value="minimax-h3">H3</option>
                    <option value="minimax-h3-max-style-vhs">H3 VHS</option>
                </select>
            </label>
            <CanvasH3Controls model={model} value={options} duration={duration} onDurationChange={setDuration} onChange={setOptions} />
            <CanvasVideoPromptTools
                metadata={metadata}
                onMetadataChange={patch}
                frameOptions={[
                    { nodeId: "image", label: "图片 1", title: "花园首帧" },
                    { nodeId: "end", label: "图片 2", title: "花园尾帧" },
                ]}
                middleFrameSupported={model === "minimax-h3-max"}
                endFrameSupported={!model.includes("style-")}
            />
            <CanvasH3ReferenceOrder
                model={model}
                metadata={metadata}
                onChange={patch}
                inputs={[
                    { nodeId: "image", type: "image", title: "花园参考图" },
                    { nodeId: "video", type: "video", title: "镜头运动参考" },
                    { nodeId: "audio", type: "audio", title: "鸟鸣声音参考" },
                ]}
            />
            <output id="h3-state" className="break-all text-xs">
                {JSON.stringify({ model, duration, options, metadata })}
            </output>
        </main>
    );
}
createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <App>
            <Harness />
        </App>
    </ConfigProvider>,
);
