import { expect, test } from "bun:test";
import { referencedAssetIdsInPrompt } from "../src/lib/canvas/canvas-resource-references";

test("library mentions grant exact IDs without requiring a canvas node", () => {
    expect(referencedAssetIdsInPrompt("参考 @[asset:library-only]，再看 @[asset:second] 和 @[asset:library-only]"))
        .toEqual(["library-only", "second"]);
});

test("labels, node mentions and incomplete tokens cannot grant library access", () => {
    expect(referencedAssetIdsInPrompt("@图片1 @图片10 @[node:library-only] @[asset:] @[asset:unfinished"))
        .toEqual([]);
});
