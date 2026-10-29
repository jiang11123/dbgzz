import { describe, expect, test } from "bun:test";
import { normalizeLocalAsset, normalizeLocalCanvasProject } from "../src/lib/local-workspace-migration";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("local workspace migration", () => {
    const root = resolve(import.meta.dir, "..");
    test("removes hosted canvas synchronization markers without changing content", () => {
        const project = { id: "p", remoteContentHash: "remote-hash", nodes: [{ id: "n" }] };
        expect(normalizeLocalCanvasProject(project)).toEqual({ id: "p", nodes: [{ id: "n" }] });
    });

    test("removes external plugin sync records without removing asset data", () => {
        const asset = { id: "a", data: { storageKey: "image:local:a" }, metadata: { externalSync: [{ sourceId: "drive" }], source: "manual" } };
        expect(normalizeLocalAsset(asset)).toEqual({ id: "a", data: { storageKey: "image:local:a" }, metadata: { source: "manual" } });
    });

    test("removes legacy remote upload state from local assets", () => {
        const asset = { id: "b", pendingRemoteUpload: true, remoteUploadError: "network", metadata: { source: "manual" } };
        expect(normalizeLocalAsset(asset)).toEqual({ id: "b", metadata: { source: "manual" } });
    });

    test("canvas and asset imports apply the local normalizer", () => {
        const canvasSource = readFileSync(resolve(root, "src/lib/canvas/canvas-archive-restore.ts"), "utf8");
        const assetSource = readFileSync(resolve(root, "src/pages/assets/index.tsx"), "utf8");
        expect(canvasSource).toContain("normalizeLocalCanvasProject(item.project)");
        expect(assetSource).toContain("normalizeLocalAsset(payload)");
    });

    test("local exports apply the same normalizer before writing portable packages", () => {
        const canvasSource = readFileSync(resolve(root, "src/lib/canvas/canvas-export.ts"), "utf8");
        const assetSource = readFileSync(resolve(root, "src/pages/assets/asset-transfer.ts"), "utf8");
        expect(canvasSource).toContain("isLocalWorkspaceMode() ? normalizeLocalCanvasProject(project) : project");
        expect(assetSource).toContain("isLocalWorkspaceMode() ? assets.map(normalizeLocalAsset) : assets");
    });
});
