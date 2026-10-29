import { expect, spyOn, test } from "bun:test";
import { resolveReferenceMediaDuration } from "../src/lib/reference-media-metadata";
import * as storage from "../src/services/file-storage";
import * as resources from "../src/services/api/resources";
import * as metadata from "../src/lib/media-metadata";
import * as projects from "../src/services/api/projects";
import { hydrateNodeGenerationContext, type NodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { createVideoGenerationTask } from "../src/services/api/video";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { assertVideoCapability } from "../src/services/api/video-validation";
import type { ReferenceAudio } from "../src/types/media";

const channel = createModelChannel({
    id: "metadata-test",
    name: "test",
    baseUrl: "https://example.com",
    apiKey: "test",
    interfaceType: "newapi-channel-2",
    models: ["seedance-2.5"],
    modelProfiles: [{ model: "seedance-2.5", protocol: "newapi-channel-2" }],
});
const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "seedance-2.5"), videoSeconds: "5" };
const profile = modelCapabilityConfigFor(config, config.model).video!;
const audio: ReferenceAudio = { id: "generated", name: "配音.mp3", type: "audio/mpeg", url: "/api/resources/generated/file", storageKey: "resource:generated" };

function mockGeneratedAudio(durationMs: number | undefined) {
    const resource = spyOn(resources, "getResource").mockResolvedValue({ id: "generated", durationMs: 0, mimeType: "audio/mpeg" } as resources.RemoteResource);
    const blob = spyOn(storage, "getMediaBlob").mockResolvedValue(new Blob(["audio"], { type: "audio/mpeg" }));
    const probe = spyOn(metadata, "probeMediaDurationMs").mockResolvedValue(durationMs);
    return {
        resource,
        blob,
        probe,
        restore() {
            resource.mockRestore();
            blob.mockRestore();
            probe.mockRestore();
        },
    };
}

test("unplayed generated audio is probed before canvas validation and its actual duration reaches the task", async () => {
    const mocks = mockGeneratedAudio(2500);
    try {
        const context: NodeGenerationContext = {
            prompt: "test",
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [audio],
            characterReferences: [],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
            textCount: 1,
            imageCount: 0,
            videoCount: 0,
            audioCount: 1,
        };
        const hydrated = await hydrateNodeGenerationContext(context, "canvas", undefined, "video");
        expect(hydrated.referenceAudios[0].durationMs).toBe(2500);
        expect(audio.durationMs).toBeUndefined();
        expect(() => assertVideoCapability(profile, [], [], hydrated.referenceAudios, "5")).not.toThrow();
        const task = await prepareBackendGenerationTask({ config, mode: "video", prompt: "test", referenceAudios: hydrated.referenceAudios });
        expect((task.input as { referenceAudios: ReferenceAudio[] }).referenceAudios[0].durationMs).toBe(2500);
        expect(mocks.probe).toHaveBeenCalledTimes(1);
        expect(mocks.blob).toHaveBeenCalledTimes(1);
    } finally {
        mocks.restore();
    }
});

test("backend preparation also probes references without a canvas", async () => {
    const mocks = mockGeneratedAudio(2500);
    try {
        const task = await prepareBackendGenerationTask({ config, mode: "video", prompt: "test", referenceAudios: [audio] });
        expect((task.input as { referenceAudios: ReferenceAudio[] }).referenceAudios[0].durationMs).toBe(2500);
    } finally {
        mocks.restore();
    }
});

test("a generated character voice sample with zero resource duration is probed before canvas preflight", async () => {
    const mocks = mockGeneratedAudio(2500);
    const character = spyOn(projects, "getProjectCharacter").mockResolvedValue({
        asset: { id: "character", title: "角色" },
        character: { versionId: "version", definition: {}, representations: [], voice: { profile: { sampleResourceId: "generated" }, instructions: "" } },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    try {
        const context: NodeGenerationContext = {
            prompt: "test",
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [{ nodeId: "character-node", assetId: "character" }],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
            textCount: 1,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
        const hydrated = await hydrateNodeGenerationContext(context, "canvas", "project", "video", true);
        expect(hydrated.referenceAudios[0].durationMs).toBe(2500);
        expect(() => assertVideoCapability(profile, [], [], hydrated.referenceAudios, "5")).not.toThrow();
        expect(mocks.probe).toHaveBeenCalledTimes(1);
    } finally {
        character.mockRestore();
        mocks.restore();
    }
});

for (const [duration, message] of [
    [900, "0.90 秒"],
    [undefined, "时长无法读取"],
] as const) {
    test(`direct submission uses real metadata and rejects ${String(duration)} before upstream submission`, async () => {
        const mocks = mockGeneratedAudio(duration);
        try {
            await expect(createVideoGenerationTask(config, "test", [], [], [audio])).rejects.toThrow(message);
            expect(mocks.probe).toHaveBeenCalledTimes(1);
        } finally {
            mocks.restore();
        }
    });
}

test("concurrent references share a probe, while known duration and remote URLs do not download", async () => {
    const mocks = mockGeneratedAudio(2500);
    try {
        const values = await Promise.all([resolveReferenceMediaDuration(audio), resolveReferenceMediaDuration({ ...audio, id: "other" })]);
        expect(values.map((value) => value.durationMs)).toEqual([2500, 2500]);
        expect(mocks.blob).toHaveBeenCalledTimes(1);
        await resolveReferenceMediaDuration({ ...audio, durationMs: 900 });
        const remote = await resolveReferenceMediaDuration({ ...audio, storageKey: undefined, url: "https://external.example/audio.mp3" });
        expect(remote.durationMs).toBeUndefined();
        expect(mocks.blob).toHaveBeenCalledTimes(1);
    } finally {
        mocks.restore();
    }
});

test("resource metadata avoids downloading media and probe failures remain unknown", async () => {
    const mocks = mockGeneratedAudio(undefined);
    try {
        mocks.resource.mockResolvedValueOnce({ durationMs: 2500 } as resources.RemoteResource);
        expect((await resolveReferenceMediaDuration(audio)).durationMs).toBe(2500);
        expect(mocks.blob).not.toHaveBeenCalled();
        mocks.blob.mockRejectedValueOnce(new Error("unreadable"));
        const unresolved = await resolveReferenceMediaDuration(audio);
        expect(() => assertVideoCapability(profile, [], [], [unresolved], "5")).toThrow("时长无法读取");
    } finally {
        mocks.restore();
    }
});


test("known video duration still resolves missing dimensions before validation", async () => {
    const blob = spyOn(storage, "getMediaBlob").mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));
    const probe = spyOn(metadata, "probeMediaMetadata").mockResolvedValue({ durationMs: 4833, width: 432, height: 768 });
    try {
        const video = await resolveReferenceMediaDuration({ id: "short-video", name: "video.mp4", type: "video/mp4", url: "blob:test", storageKey: "local-video", durationMs: 4833 });
        expect(video).toMatchObject({ width: 432, height: 768, durationMs: 4833 });
        expect(() => assertVideoCapability(profile, [], [video], [], "5")).toThrow("331776（432×768）");
        expect(probe).toHaveBeenCalledTimes(1);
    } finally { blob.mockRestore(); probe.mockRestore(); }
});

test("missing video dimensions fail closed, while opaque provider assets remain usable", () => {
    const video = { id: "v", name: "v.mp4", type: "video/mp4", url: "https://example.com/v.mp4", durationMs: 3000 };
    expect(() => assertVideoCapability(profile, [], [video], [], "5")).toThrow("尺寸无法读取");
    expect(() => assertVideoCapability(profile, [], [{ ...video, url: "asset://opaque" }], [], "5")).not.toThrow();
});
