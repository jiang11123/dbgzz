import { afterEach, expect, test } from "bun:test";
import { uploadReferenceLinks } from "../src/services/api/reference-link-replacement";
import { setActiveUserScope } from "../src/lib/user-scope";
import { backendProviderConfig, submitBackendGenerationTask } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { ApiError } from "../src/services/api/request";
import type { GenerationTask } from "../src/services/api/task-center";

const previousWindow = globalThis.window;
afterEach(() => { globalThis.window = previousWindow; });

test("shared uploader uses only selected owned references and preserves their slots", async () => {
    setActiveUserScope("reference-owner");
    let ids: string[] = [];
    globalThis.window = { go: { main: { DesktopApp: {
        ReferenceStorageSettings: async () => ({ enabled: true }),
        UploadReferenceMedia: async (input: string[]) => { ids = input; return { owned: "https://cdn.example/reference" }; },
    } } } } as unknown as Window & typeof globalThis;
    const links = await uploadReferenceLinks([
        { key: "image:0", label: "图片 1", resourceID: "owned" },
        { key: "image:1", label: "图片 2", resourceID: "owned" },
        { key: "video:0", label: "视频 1", resourceID: "manual", upload: false },
        { key: "audio:0", label: "音频 1" },
    ]);
    expect(ids).toEqual(["owned"]);
    expect(links).toEqual({ "image:0": "https://cdn.example/reference", "image:1": "https://cdn.example/reference" });
});

test("abort and account changes after settings prevent upload", async () => {
    for (const action of ["abort", "switch"] as const) {
        setActiveUserScope("reference-owner");
        const controller = new AbortController();
        let uploads = 0;
        globalThis.window = { go: { main: { DesktopApp: {
            ReferenceStorageSettings: async () => { if (action === "abort") controller.abort(); else setActiveUserScope("other-owner"); return { enabled: true }; },
            UploadReferenceMedia: async () => { uploads++; return {}; },
        } } } } as unknown as Window & typeof globalThis;
        await expect(uploadReferenceLinks([{ key: "image:0", label: "图片 1", resourceID: "owned" }], controller.signal)).rejects.toThrow();
        expect(uploads).toBe(0);
    }
});

test("all task entry points can recover URL admission using the configured desktop storage", async () => {
    setActiveUserScope("reference-owner");
    const channel = createModelChannel({ id: "third-party", baseUrl: "https://provider.example", name: "Third party", apiKey: "fixture", interfaceType: "newapi-channel-2", models: ["video"], modelProfiles: [{ model: "video", capability: "video", protocol: "newapi-channel-2", referenceMediaTransport: { image: "url", audio: "link" } }] });
    const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "video") };
    expect(backendProviderConfig(config, "video").referenceMediaTransport).toEqual({ image: "url", audio: "link" });
    let uploads = 0;
    globalThis.window = { go: { main: { DesktopApp: {
        ReferenceStorageSettings: async () => ({ enabled: true }),
        UploadReferenceMedia: async () => { uploads++; return { owned: "https://cdn.example/reference" }; },
    } } } } as unknown as Window & typeof globalThis;
    let calls = 0;
    const task = await submitBackendGenerationTask({ mode: "video", prompt: "test", config, referenceImages: [{ id: "owned", name: "image.png", type: "image/png", storageKey: "resource:owned" }] }, {
        createTask: async (input) => {
            if (calls++ === 0) throw new ApiError("need URL", { status: 400, reason: "reference_media_requires_url", details: { requiredReferences: [{ kind: "image", index: 0 }] } });
            expect(input.input?.referenceImages[0].url).toBe("https://cdn.example/reference");
            return { id: "accepted" } as GenerationTask;
        }, waitTask: async () => { throw new Error("must not poll"); }, createId: () => "shared-upload",
    });
    expect(task.id).toBe("accepted");
    expect(calls).toBe(2);
    expect(uploads).toBe(1);
});
