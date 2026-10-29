import { expect, test } from "bun:test";
import { submitBackendGenerationTask } from "../src/services/api/generation-task";
import { ApiError } from "../src/services/api/request";
import { isReferenceHTTPSLink, uploadReferenceLinks } from "../src/services/api/reference-link-replacement";
import { useOperationProgress } from "../src/stores/use-operation-progress";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { setActiveUserScope } from "../src/lib/user-scope";
import type { GenerationTask } from "../src/services/api/task-center";

const channel = createModelChannel({ id: "test-links", name: "Test", baseUrl: "https://provider.example", apiKey: "fixture", interfaceType: "openai-images", models: ["image-test"] });
const options = { mode: "image" as const, prompt: "test", config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "image-test") }, referenceImages: [{ id: "one", name: "local.png", type: "image/png", storageKey: "resource:one", width: 800, height: 600 }] };
const rejected = new ApiError("需要在线素材", { reason: "reference_media_requires_url", status: 400 });

test("concurrent native uploads poll only their own active status", async () => {
    const previousWindow = globalThis.window;
    const calls: string[] = [];
    const polls: string[] = [];
    let finishFirst!: (value: Record<string, string>) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    globalThis.window = { go: { main: { DesktopApp: {
        ReferenceStorageSettings: async () => ({ enabled: true }),
        UploadReferenceMedia: async (ids: string[]) => {
            calls.push(ids[0]);
            if (ids[0] === "first") { started(); return new Promise<Record<string, string>>(resolve => { finishFirst = resolve; }); }
            return { second: "https://cdn.example/second" };
        },
        ReferenceUploadStatus: async () => { polls.push(calls.at(-1)!); return { phase: "preparing", label: "参考素材 1", startedAt: Date.now(), updatedAt: Date.now() }; },
    } } } } as unknown as Window & typeof globalThis;
    try {
        const target = { projectId: "canvas-a", nodeId: "output-video" };
        const first = uploadReferenceLinks([{ key: "a", label: "参考图片 1", resourceID: "first" }], undefined, target);
        await firstStarted;
        expect(Object.values(useOperationProgress.getState().entries).find(entry => entry.target)?.target).toEqual(target);
        const second = uploadReferenceLinks([{ key: "b", label: "参考图片 2", resourceID: "second" }]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(calls).toEqual(["first"]);
        expect(polls).toEqual(["first"]);
        finishFirst({ first: "https://cdn.example/first" });
        expect(await first).toEqual({ a: "https://cdn.example/first" });
        expect(Object.values(useOperationProgress.getState().entries).filter(entry => entry.target)).toHaveLength(0);
        expect(await second).toEqual({ b: "https://cdn.example/second" });
        expect(polls).toEqual(["first", "second"]);
    } finally {
        globalThis.window = previousWindow;
        useOperationProgress.setState({ entries: {} });
    }
});

test("HTTPS replacement requires HTTPS without embedded credentials", () => {
    for (const value of ["http://cdn.example/x", "file:///x", "https://user:secret@cdn.example/x", "bad"]) expect(isReferenceHTTPSLink(value)).toBe(false);
    expect(isReferenceHTTPSLink(" https://cdn.example/x?signature=fixture ")).toBe(true);
});

for (const action of ["replace", "cancel", "abort", "switch", "invalid", "upstream-error"] as const) {
    test(`reference admission recovery: ${action}`, async () => {
        setActiveUserScope("link-owner");
        const calls: any[] = [];
        let prompts = 0;
        const controller = new AbortController();
        const promise = submitBackendGenerationTask({ ...options, signal: controller.signal, resolveReferenceLinks: async (refs) => {
            prompts++;
            expect(refs.map((ref) => ref.label)).toEqual(["参考图片 1"]);
            if (action === "cancel") return null;
            if (action === "abort") controller.abort();
            if (action === "switch") { setActiveUserScope("other-owner"); setActiveUserScope("link-owner"); }
            return { "referenceImages:0": action === "invalid" ? "http://cdn.example/x" : "https://cdn.example/x" };
        } }, {
            createTask: async (input) => {
                calls.push(input);
                if (calls.length === 1) throw action === "upstream-error" ? new ApiError("timeout", { status: 504 }) : rejected;
                return { id: "accepted" } as GenerationTask;
            }, waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
        });
        if (action === "replace") {
            expect((await promise).id).toBe("accepted");
            const media = calls[1].input.referenceImages[0];
            expect(media.url).toBe("https://cdn.example/x");
            expect(media.storageKey).toBeUndefined();
            expect(media.width).toBe(800);
            expect(options.referenceImages[0].storageKey).toBe("resource:one");
        } else { await expect(promise).rejects.toThrow(); }
        expect(calls.length).toBe(action === "replace" ? 2 : 1);
        expect(prompts).toBe(action === "upstream-error" ? 0 : 1);
    });
}

test("concurrent submissions retain reference order and replace mask without changing originals", async () => {
    const inputs: any[] = [];
    const references = [options.referenceImages[0], { ...options.referenceImages[0], id: "two", storageKey: "resource:two", name: "two.png" }];
    await Promise.all([0, 1].map(async () => {
        let attempt = 0;
        await submitBackendGenerationTask({ ...options, referenceImages: references, mask: { ...references[0], id: "mask", storageKey: "resource:mask" }, resolveReferenceLinks: async (refs) => {
            expect(refs.map((ref) => ref.key)).toEqual(["referenceImages:0", "referenceImages:1", "mask:0"]);
            return { "referenceImages:0": "https://cdn.example/one", "referenceImages:1": "https://cdn.example/two", "mask:0": "https://cdn.example/mask" };
        } }, {
            createTask: async (input) => { if (attempt++ === 0) throw rejected; inputs.push(input.input); return { id: "accepted" } as GenerationTask; },
            waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
        });
    }));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
        expect(input.referenceImages.map((media: any) => [media.id, media.url])).toEqual([["one", "https://cdn.example/one"], ["two", "https://cdn.example/two"]]);
        expect(input.mask.url).toBe("https://cdn.example/mask");
        expect(input.mask.storageKey).toBeUndefined();
    }
    expect(references.map((media) => media.storageKey)).toEqual(["resource:one", "resource:two"]);
});

test("second admission rejection propagates without a third submission", async () => {
    let calls = 0;
    await expect(submitBackendGenerationTask({ ...options, resolveReferenceLinks: async () => ({ "referenceImages:0": "https://cdn.example/one" }) }, {
        createTask: async () => { calls++; throw rejected; }, waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
    })).rejects.toBe(rejected);
    expect(calls).toBe(2);
});

test("pre-task reference upload targets the allocated output node", async () => {
    let attempt = 0;
    await submitBackendGenerationTask({ ...options, projectId: "canvas-a", metadata: { nodeId: "output-video", sourceNodeId: "source-video" }, resolveReferenceLinks: async (_refs, _signal, target) => {
        expect(target).toEqual({ projectId: "canvas-a", nodeId: "output-video" });
        return { "referenceImages:0": "https://cdn.example/one" };
    } }, {
        createTask: async () => { if (attempt++ === 0) throw rejected; return { id: "accepted" } as GenerationTask; },
        waitTask: async () => { throw new Error("must not poll"); }, createId: () => "unused",
    });
    expect(attempt).toBe(2);
});

test("mixed media recovery uploads only the references identified by admission", async () => {
    let calls = 0;
    let recovered: any;
    await submitBackendGenerationTask({ ...options, referenceAudios: [{ id: "audio", name: "audio.mp3", type: "audio/mpeg", durationMs: 1000, storageKey: "resource:audio" }], resolveReferenceLinks: async (refs) => {
        expect(refs.map((ref) => ref.key)).toEqual(["referenceAudios:0"]);
        return { "referenceAudios:0": "https://cdn.example/audio.mp3" };
    } }, {
        createTask: async (input) => {
            if (calls++ === 0) throw new ApiError("audio needs URL", { status: 400, reason: "reference_media_requires_url", details: { requiredReferences: [{ kind: "audio", index: 0 }] } });
            recovered = input.input;
            return { id: "accepted" } as GenerationTask;
        }, waitTask: async () => { throw new Error("must not poll"); }, createId: () => "mixed-transport",
    });
    expect(calls).toBe(2);
    expect(recovered.referenceImages[0].storageKey).toBe("resource:one");
    expect(recovered.referenceAudios[0].storageKey).toBeUndefined();
    expect(recovered.referenceAudios[0].url).toBe("https://cdn.example/audio.mp3");
});
