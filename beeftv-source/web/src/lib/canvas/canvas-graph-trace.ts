import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export const CANVAS_GRAPH_TRACE_KEY = "beeftv:canvas-graph-trace:v1";
type Graph = Partial<Pick<CanvasProject, "id" | "revision" | "nodes" | "connections">>;

function summary(graph: Graph | null | undefined) {
    if (!graph) return null;
    // Correlate a canvas without storing its identifier, title, node data or resource URLs.
    let canvas = 2166136261;
    for (const char of graph.id || "") canvas = Math.imul(canvas ^ char.charCodeAt(0), 16777619);
    return { canvas: canvas >>> 0, revision: graph.revision ?? null, nodes: graph.nodes?.length ?? null, edges: graph.connections?.length ?? null };
}

/** Bounded local diagnostic receipt survives a desktop restart; never affects persistence. */
export function traceCanvasGraph(source: string, graphs: Record<string, Graph | null | undefined>) {
    if (typeof window === "undefined") return;
    try {
        const saved: unknown = JSON.parse(window.localStorage.getItem(CANVAS_GRAPH_TRACE_KEY) || "[]");
        const events = Array.isArray(saved) ? saved : [];
        const graphCounts = Object.fromEntries(Object.entries(graphs).map(([name, graph]) => [name, summary(graph)]));
        events.push({ time: new Date().toISOString(), source, graphs: graphCounts });
        window.localStorage.setItem(CANVAS_GRAPH_TRACE_KEY, JSON.stringify(events.slice(-120)));
    } catch {
        // Diagnostics cannot interrupt edits when optional local storage is unavailable.
    }
}
