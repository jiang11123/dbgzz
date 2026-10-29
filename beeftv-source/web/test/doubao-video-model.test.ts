import { expect, test } from "bun:test";
import { isDoubaoVideoModel } from "@/lib/doubao-video-model";

test("recognizes Doubao account video models by channel-qualified or bare id", () => {
    expect(isDoubaoVideoModel("doubao-gateway::doubao-video-account-1--seedance-2-0-mini")).toBe(true);
    expect(isDoubaoVideoModel("doubao-video-account-12--seedance-2-5")).toBe(true);
    expect(isDoubaoVideoModel("doubao-video-account-3")).toBe(true);
});

test("does not match other models, Doubao text accounts or missing values", () => {
    expect(isDoubaoVideoModel("doubao-gateway::doubao-account-1")).toBe(false);
    expect(isDoubaoVideoModel("my-api::doubao-video-account-x")).toBe(false);
    expect(isDoubaoVideoModel("custom::seedance-2-0")).toBe(false);
    expect(isDoubaoVideoModel(undefined)).toBe(false);
    expect(isDoubaoVideoModel("")).toBe(false);
});

import { DEFAULT_DOUBAO_VIDEO_MODEL, DOUBAO_VIDEO_MODEL_OPTIONS, doubaoVideoProviderOptions, normalizeDoubaoVideoModel } from "@/lib/doubao-video-model";

test("one video model per account: the page video model is a node option passed via providerOptions", () => {
    expect(doubaoVideoProviderOptions("doubao-gateway::doubao-video-account-2", "Seedance 2.0 Mini")).toEqual({
        providerOptions: { "doubao-gateway-video": { video_model: "Seedance 2.0 Mini" } },
    });
    // 旧版本 id（页面模型编码在 id 里）仍然认得
    expect(doubaoVideoProviderOptions("doubao-video-account-1--seedance-2-0", "Seedance 2.0 Fast")).toEqual({
        providerOptions: { "doubao-gateway-video": { video_model: "Seedance 2.0 Fast" } },
    });
});

test("unknown or missing node choice falls back to the default Doubao video model", () => {
    expect(normalizeDoubaoVideoModel(undefined)).toBe(DEFAULT_DOUBAO_VIDEO_MODEL);
    expect(normalizeDoubaoVideoModel("not-a-model")).toBe(DEFAULT_DOUBAO_VIDEO_MODEL);
    expect(normalizeDoubaoVideoModel(42)).toBe(DEFAULT_DOUBAO_VIDEO_MODEL);
    for (const option of DOUBAO_VIDEO_MODEL_OPTIONS) expect(normalizeDoubaoVideoModel(option)).toBe(option);
    expect(doubaoVideoProviderOptions("doubao-gateway::doubao-video-account-3", "x").providerOptions?.["doubao-gateway-video"].video_model).toBe(DEFAULT_DOUBAO_VIDEO_MODEL);
});

test("non-Doubao models never get Doubao provider options", () => {
    expect(doubaoVideoProviderOptions("my-api::seedance-2-0", "Seedance 2.0")).toEqual({});
    expect(doubaoVideoProviderOptions(undefined, "Seedance 2.0")).toEqual({});
});

import { DEFAULT_DOUBAO_IMAGE_MODEL, DOUBAO_IMAGE_MODEL_OPTIONS, doubaoImageProviderOptions, isDoubaoImageModel, normalizeDoubaoImageModel } from "@/lib/doubao-image-model";

test("Doubao image models: one per account, the page image model is a node option", () => {
    expect(isDoubaoImageModel("doubao-gateway::doubao-image-account-2")).toBe(true);
    expect(isDoubaoImageModel("doubao-image-account-1")).toBe(true);
    expect(isDoubaoImageModel("doubao-gateway::doubao-video-account-2")).toBe(false);
    expect(isDoubaoImageModel("my-api::doubao-image-account-x")).toBe(false);
    expect(isDoubaoImageModel(undefined)).toBe(false);
    expect(doubaoImageProviderOptions("doubao-gateway::doubao-image-account-2", "Seedream 4.0")).toEqual({
        providerOptions: { "doubao-gateway-image": { image_model: "Seedream 4.0" } },
    });
    expect(doubaoImageProviderOptions("my-api::gpt-image", "Seedream 4.0")).toEqual({});
});

test("unknown or missing image choice falls back to the default Doubao image model", () => {
    expect(normalizeDoubaoImageModel(undefined)).toBe(DEFAULT_DOUBAO_IMAGE_MODEL);
    expect(normalizeDoubaoImageModel("nope")).toBe(DEFAULT_DOUBAO_IMAGE_MODEL);
    for (const option of DOUBAO_IMAGE_MODEL_OPTIONS) expect(normalizeDoubaoImageModel(option)).toBe(option);
});
