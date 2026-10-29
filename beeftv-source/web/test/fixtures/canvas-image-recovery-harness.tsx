import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType } from "../../src/types/canvas";
import { getClientDiagnosticEvents } from "../../src/services/diagnostics/client-diagnostics";

Object.assign(window, { imageDiagnostics: getClientDiagnosticEvents });

function Harness() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
    const scale = Number(new URLSearchParams(location.search).get("scale") || 1);
    return <div style={{ width: 300, height: 200, background: "transparent", transform: `scale(${scale})`, transformOrigin: "top left", "--canvas-live-inverse-scale": 1 / scale } as React.CSSProperties}><CanvasNodeContent scale={scale}
        node={{ id: "preview", title: "生成图片", type: CanvasNodeType.Image, width: 300, height: 200, position: { x: 0, y: 0 }, metadata: { content: "/api/resources/preview/file?token=DO_NOT_LOG", storageKey: "resource:preview", taskId: "original-image-task", status: "success" } }}
        theme={canvasThemes[theme]} isEditingContent={false} textareaRef={textareaRef} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]}
    /></div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
