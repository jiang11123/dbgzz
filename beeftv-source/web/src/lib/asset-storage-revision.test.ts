import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { parseAssetRecord } from "./asset-record.ts";

test("缺失图片数据的历史素材会被拒绝，而不是补齐可渲染字段", () => {
    assert.throws(() => parseAssetRecord({
        id: "legacy-image",
        kind: "image",
        title: "历史图片",
        coverUrl: "https://example.com/image.png",
        tags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        data: undefined,
    }), /data/);
});
