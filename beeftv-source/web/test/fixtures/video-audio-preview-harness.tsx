import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

async function videoFixture() {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const done = new Promise<string>((resolve) => {
        recorder.onstop = () => {
            stream.getTracks().forEach((track) => track.stop());
            resolve(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })));
        };
    });
    recorder.start();
    for (let frame = 0; frame < 30; frame++) {
        context.fillStyle = `hsl(${frame * 12}, 65%, 45%)`;
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = "white";
        context.font = "24px sans-serif";
        context.fillText(`Video frame ${frame}`, 40, 95);
        await new Promise((resolve) => setTimeout(resolve, 70));
    }
    recorder.stop();
    return done;
}

function Harness({ content }: { content: string }) {
    const [active, setActive] = useState(false);
    const ref = useRef<HTMLTextAreaElement>(null);
    const raw = new URLSearchParams(location.search).get("value") || "true";
    const node: CanvasNodeData = JSON.parse(JSON.stringify({
        id: "fixture-video", type: CanvasNodeType.Video, title: "Preview regression",
        position: { x: 0, y: 0 }, width: 320, height: 180,
        metadata: { content, mimeType: "video/webm", generateAudio: JSON.parse(raw), status: "success" },
    }));
    return <><button onClick={() => setActive(true)}>Play fixture</button><output>{active ? "active" : "inactive"}</output>
        <div style={{ position: "relative", width: 320, height: 180 }}>
            <CanvasNodeContent node={node} theme={canvasThemes.dark} mediaActive={active} onMediaPlayRequest={() => setActive(true)}
                isEditingContent={false} textareaRef={ref} isBatchRoot={false} batchCount={1} batchExpanded={false}
                batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]} />
        </div></>;
}

videoFixture().then((content) => createRoot(document.getElementById("root")!).render(<Harness content={content} />));
