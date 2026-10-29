import { expect, test } from "bun:test";
import { CANVAS_GRAPH_TRACE_KEY, traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";

test("canvas diagnostics retain only bounded structural counts, never content or identifiers", () => {
    const previous = globalThis.window;
    const storage = new Map<string, string>();
    globalThis.window = { localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) } } as never;
    try {
        for (let i = 0; i < 130; i++) traceCanvasGraph("test", { graph: { id: "private-id", revision: i, nodes: [{ id: "private-node", metadata: { content: "https://secret.example/token" } }] as never, connections: [] } });
        const raw = storage.get(CANVAS_GRAPH_TRACE_KEY)!;
        const events = JSON.parse(raw);
        expect(events).toHaveLength(120);
        expect(events.at(-1).graphs.graph).toMatchObject({ revision: 129, nodes: 1, edges: 0 });
        expect(raw).not.toContain("private");
        expect(raw).not.toContain("secret");
        expect(raw).not.toContain("https");
        globalThis.window.localStorage.setItem = () => { throw new Error("storage unavailable"); };
        expect(() => traceCanvasGraph("test", {})).not.toThrow();
    } finally { globalThis.window = previous; }
});
