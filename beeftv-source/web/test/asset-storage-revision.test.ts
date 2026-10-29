import { describe, expect, test } from "bun:test";

import { parseAssetRecord } from "@/lib/asset-record";
import { parseAssetStorageDocument, parseAssetStorageDocumentRecovering } from "@/lib/asset-storage-revision";
import type { Asset } from "@/stores/use-asset-store";

const completeAsset = {
    id: "library-image",
    kind: "image",
    title: "素材",
    coverUrl: "",
    tags: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    data: { dataUrl: "opaque://legacy", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
} as Asset;

describe("asset storage revision", () => {
    test("parses complete persisted assets without rewriting tags", () => {
        const document = parseAssetStorageDocument(JSON.stringify({
            state: { assets: [completeAsset] },
            version: 1,
            storageRevision: 3,
            tombstones: { assets: {} },
        }));

        expect(document.state.assets[0]?.tags).toEqual([]);
        expect(document.state.assets[0]?.tags.join(" ")).toBe("");
        expect(parseAssetRecord(completeAsset).id).toBe("library-image");
    });

    test("rejects persisted assets that are missing tags", () => {
        const { tags: _tags, ...legacyAsset } = completeAsset;
        expect(() => parseAssetStorageDocument(JSON.stringify({
            state: { assets: [legacyAsset] },
            version: 1,
            storageRevision: 3,
            tombstones: { assets: {} },
        }))).toThrow(/tags/);
    });


    test("isolates malformed historical records while preserving valid assets", () => {
        const { tags: _tags, ...legacyAsset } = completeAsset;
        const recovery = parseAssetStorageDocumentRecovering(JSON.stringify({
            state: { assets: [legacyAsset, completeAsset] },
            version: 1,
            storageRevision: 3,
            tombstones: { assets: {} },
        }));

        expect(recovery.document.state.assets.map((asset) => asset.id)).toEqual(["library-image"]);
        expect(recovery.invalid).toEqual([{ index: 0, id: "library-image", error: expect.stringMatching(/tags/) }]);
    });
});
