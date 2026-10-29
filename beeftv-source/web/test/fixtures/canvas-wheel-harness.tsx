import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";

function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const live = useRef(viewport);
    Object.assign(window, { commitWheelViewport: () => flushSync(() => setViewport(live.current)) });
    return <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={setViewport} onViewportPreviewChange={(next) => { live.current = next; }}>
        <div id="node" style={{ position: "absolute", left: 200, top: 100, width: 100, height: 80, background: "red" }} />
    </InfiniteCanvas>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
