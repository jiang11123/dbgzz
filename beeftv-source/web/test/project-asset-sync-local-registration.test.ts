import { expect, test } from "bun:test";

import type { Asset } from "../src/stores/use-asset-store";

test("materialized local resource asset is registered before canvas persistence can reference it", async () => {
    const module = await import("../src/services/project-asset-sync");
    const register = (module as unknown as {
        registerMaterializedLocalAsset?: (
            asset: Asset,
            dependencies: {
                localWorkspace: () => boolean;
                putAsset: (id: string, asset: Asset) => Promise<void>;
            },
        ) => Promise<void>;
    }).registerMaterializedLocalAsset;
    expect(typeof register).toBe("function");

    const calls: Array<{ id: string; storageKey?: string }> = [];
    const asset = {
        id: "generation-result",
        kind: "image",
        title: "生成图片",
        coverUrl: "/api/resources/result-resource/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "生成任务",
        metadata: {},
        data: {
            dataUrl: "/api/resources/result-resource/file",
            storageKey: "resource:result-resource",
            width: 1024,
            height: 1024,
            bytes: 123,
            mimeType: "image/png",
        },
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
    } satisfies Asset;

    await register!(asset, {
        localWorkspace: () => true,
        putAsset: async (id, payload) => {
            calls.push({ id, storageKey: payload.kind === "image" ? payload.data.storageKey : undefined });
        },
    });

    expect(calls).toEqual([{ id: "generation-result", storageKey: "resource:result-resource" }]);
});

test("already-materialized task output repairs a missing backend asset registration", async () => {
    const module = await import("../src/services/project-asset-sync");
    const registerTaskAssets = (module as unknown as {
        registerMaterializedTaskAssets?: (
            task: { outputs?: Array<{ outputIndex: number; mediaType: "image"; materializedAssetId?: string }> },
            assets: Asset[],
            register: (asset: Asset) => Promise<void>,
        ) => Promise<void>;
    }).registerMaterializedTaskAssets;
    expect(typeof registerTaskAssets).toBe("function");

    const asset = {
        id: "generation-existing",
        kind: "image",
        title: "已物化图片",
        coverUrl: "/api/resources/existing-resource/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "生成任务",
        metadata: {},
        data: { dataUrl: "/api/resources/existing-resource/file", storageKey: "resource:existing-resource", width: 1024, height: 1024, bytes: 1, mimeType: "image/png" },
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
    } satisfies Asset;
    const registered: string[] = [];

    await registerTaskAssets!(
        { outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: asset.id }] },
        [asset],
        async (candidate) => { registered.push(candidate.id); },
    );

    expect(registered).toEqual(["generation-existing"]);
});
