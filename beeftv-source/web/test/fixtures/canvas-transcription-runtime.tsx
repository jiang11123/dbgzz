import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasTranscriptionControls } from "@/components/canvas/canvas-transcription-controls";
import type { SrtEntry } from "@/types/timeline";
import { CanvasNodeToolbar } from "@/components/canvas/canvas-node-toolbar";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function Fixture() {
    const [running, setRunning] = useState(false);
    const [entries, setEntries] = useState<SrtEntry[]>([]);
    const [open, setOpen] = useState(false);
    const [audio, setAudio] = useState(false);
    const [selectedNode, setSelectedNode] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);
    const [ready, setReady] = useState(false);
    useEffect(() => { setReady(true); }, []);
    const node: CanvasNodeData = { id: audio ? "audio-fixture" : "video-fixture", type: audio ? CanvasNodeType.Audio : CanvasNodeType.Video,
        title: "转写素材", position: { x: 100, y: 180 }, width: 320, height: 180, metadata: { storageKey: "resource:resource-fixture", content: "fixture.wav" } };
    const noop = () => {};
    const handlers = Object.fromEntries(["onKeep", "onLeave", "onInfo", "onEditText", "onDecreaseFont", "onIncreaseFont", "onToggleDialog", "onAnnotate", "onGenerateImage", "onUpload", "onDownload", "onSaveAsset", "onMaskEdit", "onEmotion", "onPortraitTexture", "onCrop", "onSplit", "onUpscale", "onSuperResolve", "onAngle", "onLighting", "onPanorama", "onViewImage", "onExtractVideoFrames", "onExtractAudioFromVideo", "onTrimVideoSegments", "onDepthCapture", "onTimeline", "onReversePrompt", "onRetry", "onToggleFreeResize", "onToggleLocked", "onDelete"].map(name => [name, noop]));
    const toolbarProps = { ...handlers, node, viewport: { x: 0, y: 0, k: 1 }, containerRef,
        extractingVideoFrames: false, extractingAudio: false, trimmingVideo: false,
        onSubtitles: (target: CanvasNodeData) => { setSelectedNode(target.id); setOpen(true); },
    } as React.ComponentProps<typeof CanvasNodeToolbar>;
    return <><div ref={containerRef} data-testid="toolbar-container" style={{ position: "relative", width: 1100, height: 300 }}><div data-node-id={node.id} style={{ position: "absolute", left: 100, top: 180, width: 320, height: 100 }}>真实节点工具栏测试素材</div>{ready && <CanvasNodeToolbar {...toolbarProps} />}</div>
        <button onClick={() => setAudio(value => !value)}>切换音视频素材</button><output data-testid="selected-node">{selectedNode}</output>
        <button onClick={() => setOpen(value => !value)}>{open ? "关闭测试窗口" : "重新打开"}</button><output data-testid="running">{String(running)}</output>{open && <CanvasTranscriptionControls projectId="project-fixture" nodeId={node.id} resourceId="resource-fixture" disabled={running} onRunningChange={setRunning} onResult={setEntries} />}<output data-testid="subtitles">{JSON.stringify(entries)}</output></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
