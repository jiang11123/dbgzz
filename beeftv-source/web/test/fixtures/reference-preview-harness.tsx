import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useResolvedCanvasResourceReferences } from "@/components/canvas/use-resolved-canvas-resource-references";
import { acquireCanvasVideoPreview } from "@/services/canvas-video-preview";
import { setActiveUserScope } from "@/lib/user-scope";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";

const harness = window as any;
harness.captures = [];
harness.pending = new Map();
harness.revoked = [];
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { harness.revoked.push(url); revoke(url); };
harness.switchScope = setActiveUserScope;
const held: ReturnType<typeof acquireCanvasVideoPreview>[] = [];
harness.holdVideo = async (id: string) => {
    const lease = acquireCanvasVideoPreview({ metadata: { content: id } });
    held.push(lease);
    await lease.promise;
};
harness.releaseHeld = () => held.splice(0).forEach(lease => lease.release());
harness.probePool = async () => {
    const lease = acquireCanvasVideoPreview({ metadata: { content: "probe" } });
    const result = await lease.promise;
    lease.release();
    return Boolean(result?.content);
};

function Harness() {
    const [references, setReferences] = useState<CanvasResourceReference[]>([]);
    const [showMenu, setShowMenu] = useState(false);
    const [value, setValue] = useState("");
    const resolved = useResolvedCanvasResourceReferences(references);
    harness.setReferences = setReferences;
    harness.showMenu = () => setShowMenu(true);
    return <><pre id="result">{JSON.stringify(resolved.map(({ id, previewUrl }) => ({ id, previewUrl })))}</pre>
        <div id="resolved-previews">{resolved.map(reference => reference.previewUrl && <img key={reference.id} data-reference-id={reference.id} src={reference.previewUrl} />)}</div>
        {showMenu && <CanvasResourceMentionTextarea value={value} onChange={setValue} references={references} onSelectReference={(reference) => reference} aria-label="引用编辑" />}</>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
