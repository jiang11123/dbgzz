import "../helpers/localforage-bun-memory";
import { mock } from "bun:test";
import { strict as assert } from "node:assert";

const original = { ...await import("@/services/image-storage") };
let uploads = 0;
mock.module("@/services/image-storage", () => ({ ...original,
    resolveImageUrl: async (key: string) => { assert.ok(key.startsWith("resource:")); return `/api/resources/${key.slice(9)}/file`; },
    uploadImage: async () => { uploads++; throw new Error("history must reuse saved outputs"); },
}));
const { insertCanvasGenerationHistoryTask } = await import("@/pages/canvas/canvas-generation-orchestration");
const { useAssetStore } = await import("@/stores/use-asset-store");
const assets: any[] = Array.from({ length: 4 }, (_, index) => ({ id: `asset-${index}`, kind: "image", title: "MJ", tags: [], createdAt: "2026-10-17", updatedAt: "2026-10-17", coverUrl: `/api/resources/local-${index}/file`, data: { storageKey: `resource:local-${index}`, dataUrl: "", width: 1024, height: 1024, bytes: 100, mimeType: "image/png" } }));
useAssetStore.setState({ assets });
const task: any = { id: "paid-mj", type: "canvas_image", model: "beefapi::midjourney-v8.2", status: "succeeded", prompt: "red cube", resultJson: JSON.stringify({ images: assets.map(() => ({ url: "https://expired-provider.example/image.png" })) }), outputs: assets.map((asset, outputIndex) => ({ outputIndex, mediaType: "image", materializedAssetId: asset.id })) };
let persisted: any[] = [];
const result = await insertCanvasGenerationHistoryTask({ task, projectId: "canvas", center: { x: 0, y: 0 }, nodes: [], assets,
    readLiveNodes: () => [], persist: async (nodes) => { persisted = nodes; },
    ensureAsset: async () => { throw new Error("must reuse original asset"); },
});
assert.equal(uploads, 0);
assert.equal(result.insertedNodes?.length, 4);
assert.equal(persisted.length, 4);
assert.deepEqual(persisted.map((node) => [node.metadata.taskOutputIndex, node.metadata.assetId, node.metadata.storageKey]), assets.map((asset, index) => [index, asset.id, asset.data.storageKey]));
console.log("PASS: four local history outputs, no provider download or new create");
