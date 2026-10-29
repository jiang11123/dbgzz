import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildCanvasSpatialIndex, canvasNodeBounds } from "../src/lib/canvas/canvas-spatial-index";

// Deterministic CPU-only baseline. This does not measure React frames, SQLite,
// resource decoding, or end-to-end save latency; those need separate fixtures.
const samples = 21;
function measure(run: () => unknown) {
    for (let i = 0; i < 3; i++) run();
    const durations = Array.from({ length: samples }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((a, b) => a - b);
    return { medianMs: durations[Math.floor(samples / 2)], p95Ms: durations[Math.ceil(samples * 0.95) - 1] };
}

const results = [1000, 10000, 50000].map((nodeCount) => {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        id: `node-${index}`,
        type: index % 50 < 35 ? "image" : index % 50 < 49 ? "video" : "text",
        title: `节点 ${index}`,
        position: { x: (index % 250) * 360, y: Math.floor(index / 250) * 220 },
        width: 320,
        height: 180,
        metadata: { resourceId: `fixture-${index}` },
    }));
    const document = { id: "performance-fixture", nodes, connections: [], chatSessions: [] };
    const serialized = JSON.stringify(document);
    const entries = nodes.map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node.id }));
    const spatial = buildCanvasSpatialIndex(entries);
    return {
        nodeCount,
        serializedBytes: Buffer.byteLength(serialized),
        serialize: measure(() => JSON.stringify(document)),
        parse: measure(() => JSON.parse(serialized)),
        buildSpatialIndex: measure(() => buildCanvasSpatialIndex(entries)),
        query500Viewports: measure(() => {
            for (let i = 0; i < 500; i++) {
                const x = (i % 100) * 180;
                const y = Math.floor(i / 100) * 220;
                spatial.query({ left: x, top: y, right: x + 1600, bottom: y + 900 }, 720);
            }
        }),
    };
});

const report = {
    fixtureVersion: 1,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    measuredAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}/${process.arch}`,
    samples,
    warmup: 3,
    results,
};

// The documented regression gate requires both relative and absolute slowdown.
// A different fixture/runtime is not a comparable baseline.
const baselinePath = process.argv[2];
const regressions: Array<{ nodeCount: number; metric: string; baselineMs: number; currentMs: number }> = [];
if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof report;
    if (baseline.fixtureVersion !== report.fixtureVersion || baseline.runtime !== report.runtime || baseline.platform !== report.platform) {
        throw new Error("性能基线的 fixture、运行时或平台不一致，不能比较");
    }
    for (const result of results) {
        const previous = baseline.results.find((row) => row.nodeCount === result.nodeCount);
        if (!previous || previous.serializedBytes !== result.serializedBytes) throw new Error("性能基线缺少同规模的固定数据");
        for (const metric of ["serialize", "parse", "buildSpatialIndex", "query500Viewports"] as const) {
            const baselineMs = previous[metric]?.medianMs;
            const currentMs = result[metric].medianMs;
            if (!Number.isFinite(baselineMs) || baselineMs < 0) throw new Error("性能基线测量值无效");
            if (currentMs > baselineMs * 1.5 && currentMs - baselineMs > 2) {
                regressions.push({ nodeCount: result.nodeCount, metric, baselineMs, currentMs });
            }
        }
    }
}
console.log(JSON.stringify({ ...report, ...(baselinePath ? { baselineCompared: true, regressions } : {}) }, null, 2));
if (regressions.length) process.exitCode = 1;
