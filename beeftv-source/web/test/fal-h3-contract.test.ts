import { expect, test } from "bun:test";
import { beefAPIVideoContract } from "../src/lib/beefapi-video-contracts";
import { portraitPriceLines, sanitizeVideoPriceQuote } from "../src/lib/seedance-portrait";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";
import { createVideoGenerationsTask } from "../src/services/api/video-provider-newapi";
import { createVideoTransport } from "../src/services/api/video-transport";
import { videoResponseTools } from "../src/services/api/video-response";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { h3VideoOperation } from "../src/lib/h3-video";
import { SYSTEM_PROMPT } from "../../agent-host/system-prompt.mjs";

test("H3 preserves CNY seconds and 768p without accepting unverified model aliases", () => {
    expect(beefAPIVideoContract("minimax-h3-max-turbo")?.protocol).toBe("newapi-channel-2");
    expect(beefAPIVideoContract("minimax-h3-max")?.protocol).toBe("newapi-channel-2");
    expect(beefAPIVideoContract("minimax-h3")?.maxReferences).toEqual({image: 9, video: 3, audio: 3});
    expect(beefAPIVideoContract("minimax-h3-max-turbo-other")).toBeUndefined();
    const price = {currency: "CNY", mode: "seconds", rates: {"768p": {output: 0.2441304, reference_video: 0}}};
    expect(sanitizeVideoPriceQuote(price)).toEqual(price);
    expect(portraitPriceLines(price)).toEqual(["768p：¥0.2441 / 秒"]);
    expect(sanitizeVideoPriceQuote({...price, currency: "USD"})).toBeNull();
});

test("H3 2K price includes the first-five-reference-image allowance", () => {
    const price = {currency: "CNY", mode: "seconds", rates: {"2k": {output: 1.322373, reference_video: 0}, "4k": {output: 1.627536, reference_video: 0}}, reference_image: 0.813768, free_reference_images: 5};
    expect(sanitizeVideoPriceQuote(price)).toEqual(price);
    expect(portraitPriceLines(price)).toEqual(["2k：¥1.3224 / 秒", "4k：¥1.6275 / 秒", "前 5 张参考图免费，之后 ¥0.8138 / 张"]);
    expect(sanitizeVideoPriceQuote({...price, free_reference_images: -1})).toBeNull();
    expect(sanitizeVideoPriceQuote({...price, reference_image: NaN})).toBeNull();
});

test("H3 base transport sends reference images to the multimodal route", async () => {
    const model = "minimax-h3";
    const channel = createModelChannel({id:"beefapi",baseUrl:"https://beeftv.app",models:[model]});
    channel.modelProfiles = mergeFetchedChannelModelProfiles(channel,[{id:model,supportedEndpointTypes:["openai-video"],videoCapabilitiesVersion:"h3-base",videoCapabilities:{
        references:{promptMaxChars:50000,minImages:0,maxImages:9,maxImageBytes:31457280,maxVideos:3,maxVideoBytes:52428800,maxAudios:3,maxAudioBytes:15000000},
        duration:{selection:"range",min:5,max:15,step:1,default:5},ratios:["16:9","adaptive"],defaultRatio:"16:9",resolutions:["2k","480p","768p","4k"],defaultResolution:"2k",generateAudio:{supported:false,default:true},watermark:{supported:false,default:false},operations:["text_to_video","image_to_video","audio_to_video","reference_to_video"],defaultOperation:"text_to_video",
    }}]);
    const snapshot = normalizeConfigSnapshot({config:{...defaultConfig,channels:[channel],vquality:"2k",videoSeconds:"5"}}).config;
    const config = resolveModelRequestConfig(snapshot,`beefapi::${model}`);
    const calls: unknown[] = [];
    const deps = {response:videoResponseTools,transport:{...createVideoTransport(config),post:async <T>(_url:string,body:unknown)=>{calls.push(body);return {id:"base-original"} as T;}}};
    const image = {id:"subject",name:"subject.png",type:"image/png",dataUrl:"data:image/png;base64,dGVzdA=="};
    await createVideoGenerationsTask(deps,config,model,"Image 1 moves.",[image],[],[]);
    expect(calls[0]).toMatchObject({model,operation:"reference_to_video",resolution:"2k",aspect_ratio:"1:1",reference_image_urls:[image.dataUrl]});
    expect((calls[0] as Record<string,unknown>).first_frame_url).toBeUndefined();
    await createVideoGenerationsTask(deps,config,model,"Last frame.",[image],[],[],{videoEndFrameNodeId:image.id});
    expect(calls[1]).toMatchObject({model,resolution:"2k",last_frame_url:image.dataUrl});
    expect((calls[1] as Record<string,unknown>).reference_image_urls).toBeUndefined();
    expect((calls[1] as Record<string,unknown>).aspect_ratio).toBeUndefined();
    await createVideoGenerationsTask(deps,{...config,size:""},model,"Reference.",[image],[],[]);
    expect(calls[2]).toMatchObject({operation:"reference_to_video",aspect_ratio:"adaptive"});
    await createVideoGenerationsTask(deps,{...config,size:""},model,"Text.",[],[],[]);
    expect(calls[3]).toMatchObject({aspect_ratio:"16:9"});
});

test("H3 direct transport keeps end-only roles, 768p and local media", async () => {
    const model = "minimax-h3-max-turbo";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://beeftv.app", models: [model]});
    channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [{id: model, supportedEndpointTypes: ["openai-video"], videoCapabilitiesVersion: "test-gateway-h3", videoCapabilities: {
        references: {promptMaxChars: 50000, minImages: 0, maxImages: 2, maxImageBytes: 31457280, maxVideos: 0, maxAudios: 1, maxAudioBytes: 15000000, minAudioDurationSeconds: 2},
        duration: {selection: "range", min: 1, max: 15, step: 1, default: 5},
        ratios: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"], defaultRatio: "16:9",
        resolutions: ["768p", "480p", "1080p"], defaultResolution: "768p",
        generateAudio: {supported: false, default: true}, watermark: {supported: false, default: false},
        operations: ["text_to_video", "image_to_video", "audio_to_video"], defaultOperation: "text_to_video",
    }}]);
    const snapshot = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel], vquality: "768", videoSeconds: "5"}}).config;
    const config = resolveModelRequestConfig(snapshot, `beefapi::${model}`);
    expect(config.interfaceType).toBe("newapi-channel-2");
    expect(modelCapabilityConfigFor(snapshot, `beefapi::${model}`).video!.resolutions).toEqual(["768p", "480p", "1080p"]);
    const calls: unknown[] = [];
    const deps = {response: videoResponseTools, transport: {...createVideoTransport(config), post: async <T>(url: string, body: unknown) => { calls.push({url, body}); return {id: "original", status: "queued"} as T; }}};
    const image = {id: "last", name: "last.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA=="};
    await createVideoGenerationsTask(deps, config, model, "test", [image], [], [], {videoEndFrameNodeId: "last"});
    expect(calls[0]).toMatchObject({body: {model, last_frame_url: image.dataUrl, resolution: "768p", seconds: "5"}});
    const payload = (calls[0] as {body: Record<string, unknown>}).body;
    expect(payload.first_frame_url).toBeUndefined(); expect(payload.generate_audio).toBeUndefined(); expect(payload.image_urls).toBeUndefined();
    await expect(createVideoGenerationsTask(deps, config, model, "test", [image], [], [], {videoEndFrameNodeId: "missing"})).rejects.toThrow("关键帧");
    expect(calls).toHaveLength(1);
    await createVideoGenerationsTask(deps,{...config,size:"9:16"},model,"Text.",[],[],[]);
    expect(calls[1]).toMatchObject({body:{aspect_ratio:"9:16"}});
});

test("assistant H3 guidance matches canvas frame selection and transport aspect inheritance", async () => {
    for (const instruction of ["一张图作为首帧", "两张图作为首尾帧", "画幅随图片", "为各镜头生成", "不用于多素材参考模式"]) {
        expect(SYSTEM_PROMPT).toContain(instruction);
    }
    const images = ["first", "last"].map(id => ({ id, name: `${id}.png`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(id)}` }));
    for (const model of ["minimax-h3", "minimax-h3-max", "minimax-h3-max-turbo"]) {
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app", models: [model] });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [{ id: model, supportedEndpointTypes: ["openai-video"], videoCapabilitiesVersion: "fixture-frames", videoCapabilities: {
            references: { promptMaxChars: 50000, minImages: 0, maxImages: 2, maxImageBytes: 31457280, maxVideos: 0, maxAudios: 0 },
            duration: { selection: "range", min: 5, max: 15, step: 1, default: 5 },
            ratios: ["16:9", "9:16"], defaultRatio: "16:9", resolutions: ["768p"], defaultResolution: "768p",
            generateAudio: { supported: false, default: true }, watermark: { supported: false, default: false },
            operations: model === "minimax-h3" ? ["text_to_video", "image_to_video", "reference_to_video"] : ["text_to_video", "image_to_video"], defaultOperation: "text_to_video",
        }}]);
        const snapshot = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], size: "9:16", vquality: "768", videoSeconds: "6" } }).config;
        const config = resolveModelRequestConfig(snapshot, `beefapi::${model}`);
        const calls: Record<string, unknown>[] = [];
        const deps = { response: videoResponseTools, transport: { ...createVideoTransport(config), post: async <T>(_url: string, body: unknown) => { calls.push(body as Record<string, unknown>); return { id: "fixture-task" } as T; } } };
        for (const count of [1, 2]) {
            const operation = h3VideoOperation(model, { imageCount: count, videoCount: 0, audioCount: 0 });
            await createVideoGenerationsTask(deps, config, model, "Fixture shot", images.slice(0, count), [], [], { videoEditOperation: operation });
            const payload = calls.at(-1)!;
            expect(operation).toBe("image_to_video");
            expect(payload.first_frame_url).toBe(images[0]!.dataUrl);
            expect(payload.last_frame_url).toBe(count === 2 ? images[1]!.dataUrl : undefined);
            expect(payload.aspect_ratio).toBeUndefined();
        }
        if (model === "minimax-h3") {
            await createVideoGenerationsTask(deps, config, model, "Existing reference mode", images.slice(0, 1), [], [], { videoEditOperation: "reference_to_video" });
            expect(calls.at(-1)).toMatchObject({ operation: "reference_to_video", aspect_ratio: "9:16", reference_image_urls: [images[0]!.dataUrl] });
            expect(calls.at(-1)!.first_frame_url).toBeUndefined();
        }
    }
});
