import { createRoot } from "react-dom/client";
import { App } from "antd";
import { EditorStoreProvider } from "../../src/components/editor/editor-context";
import { createEditorStore } from "../../src/stores/editor/editor-store";
import { EditorExport } from "../../src/lib/plugins/builtin/editor/editor-export";
import { CanvasTimelineDialog } from "../../src/components/canvas/canvas-timeline-dialog";
import { exportTimelineToMp4 } from "../../src/lib/timeline/timeline-export";
import type { CanvasNodeData } from "../../src/types/canvas";
import type { TimelineProject } from "../../src/types/timeline";

const params = new URLSearchParams(location.search);
const project: TimelineProject = {
    version: 2, durationMs: 6000,
    tracks: ["video", "voice", "bgm", "subtitle"].map((id, order) => ({ id, kind: id === "video" ? "video" : id === "subtitle" ? "subtitle" : "audio", label: id, order })),
    clips: [0, 1, 2].map((index) => ({ id: `v${index}`, nodeId: `v${index}`, trackId: "video", kind: "video", startMs: index * 2000, durationMs: 2000, directMedia: { id: `v${index}`, title: `v${index}`, kind: "video", url: `/fixtures/${params.has("broken") && index === 0 ? "broken.mp4" : `v${index}.mp4`}` } })),
};
project.clips.push({ id: "voice", nodeId: "voice", trackId: "voice", kind: "audio", startMs: 1000, durationMs: 2000, sourceStartMs: 500, directMedia: { id: "voice", title: "voice", kind: "audio", url: "/fixtures/voice.wav" } });
project.clips.push({ id: "bgm", nodeId: "bgm", trackId: "bgm", kind: "audio", startMs: 0, durationMs: 6000, volume: 0.2, directMedia: { id: "bgm", title: "bgm", kind: "audio", url: "/fixtures/bgm.wav" } });
project.clips.push({ id: "sub", nodeId: "sub", trackId: "subtitle", kind: "subtitle", startMs: 500, durationMs: 5000, text: params.has("longSubtitle") ? "中文字幕".repeat(1000) : "中文字幕完整性验证" });
const node = { id: "v0", type: "video", title: "Worker真实成片", metadata: {}, x: 0, y: 0, width: 320, height: 180 } as CanvasNodeData;
const store = createEditorStore();
store.getState().load(project);
const root = createRoot(document.getElementById("root")!);
const receipt = { created: 0, bytes: 0, progress: [] as string[], error: "", done: false };
const sources = project.clips.filter((clip) => clip.directMedia).map((clip, index) => ({ nodeId: clip.nodeId, fileName: `input-${index}.mp4`, durationMs: 6000, url: clip.directMedia!.url }));
let controller: AbortController | undefined;
Object.assign(window, { timelineWorker: {
    receipt, project, unmount: () => root.unmount(),
    cancel: () => controller?.abort(),
    run: async (outputName = "export.mp4") => {
        controller = new AbortController();
        receipt.error = ""; receipt.done = false; receipt.progress = [];
        try {
            const blob = await exportTimelineToMp4(project, sources, { signal: controller.signal, context: { width: 320, height: 180, outputName }, onProgress: (p) => receipt.progress.push(p.detail) });
            receipt.bytes = blob.size; receipt.done = true;
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "runtime.mp4"; a.click();
        } catch (error) { receipt.error = `${(error as Error).name}: ${(error as Error).message}`; }
    },
} });
if (params.get("mode") !== "runtime") root.render(<App>{params.get("mode") === "canvas" ?
    <CanvasTimelineDialog node={node} nodes={[]} timeline={project} open onClose={() => root.unmount()}
        onSave={() => {}} onSaveSubtitles={() => {}} onUploadLocalFiles={async () => []}
        onCreateAssembledNode={async (blob) => {
            receipt.created++; receipt.bytes = blob.size;
            // The persistence callback is an explicit test boundary. The supplied Blob is real worker output.
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "new-node.mp4"; a.click();
            return node;
        }} /> :
    <EditorStoreProvider store={store} host={{ projectId: "fixture", assets: [], refreshAssets: async () => [] }}><EditorExport /></EditorStoreProvider>
}</App>);
