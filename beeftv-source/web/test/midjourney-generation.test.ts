import { expect, test } from "bun:test";
import { canvasGenerationTaskNodes } from "@/pages/canvas/canvas-generation-failure";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeImageValue } from "@/lib/model-capabilities";
import { CanvasNodeType } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

test("Midjourney exposes fixed four-image settings and tracks delivery for each candidate", () => {
    const profile = defaultModelCapabilityConfig("openai-image", "midjourney-v8.2").image!;
    expect(normalizeImageValue(profile, { count: "1", size: "16:9", quality: "high" })).toMatchObject({ count: "4", size: "16:9", quality: "auto" });
    expect(profile.size.presets?.filter((preset) => preset.tier === "2k")).toHaveLength(0);
    expect(normalizeImageValue(profile, { count: "4", size: "1456x816" }).size).toBe("1456x816");
    const nodes = [0, 1].map((index) => ({ id: String(index), type: CanvasNodeType.Image, title: "MJ", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { taskOutputIndex: index, content: `image:${index}` } }));
    const task = { id: "task", type: "canvas_image", status: "succeeded", stage: "delivery_paused", outputs: [{ outputIndex: 0, materializedAssetId: "first" }, { outputIndex: 1, materializationErrorCode: "delivery_paused" }] } as GenerationTask;
    expect(canvasGenerationTaskNodes(nodes, "0", task)[0]!.metadata!.status).toBe("success");
    expect(canvasGenerationTaskNodes(nodes, "1", task)[1]!.metadata).toMatchObject({ status: "error", resourceReloadAvailable: true });
});

test("Midjourney creates one four-image task and preserves all output identities during recovery", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/midjourney-generation.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: one paid task, four indexed outputs");
}, 15000);


test("Midjourney history reuses all four durable local assets", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/midjourney-history.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: four local history outputs");
}, 15000);

for (const total of [8, 12]) test(`Midjourney generates exactly ${total} outputs in isolated native batches`, async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/midjourney-generation.fixture.ts"], { cwd: import.meta.dir + "/..", env: { ...process.env, MJ_OUTPUTS: String(total) }, stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
}, 15000);

test("Midjourney total counts are limited to exact native batches", () => {
 const profile = defaultModelCapabilityConfig("openai-image", "midjourney-v8.2").image!;
 for (const count of [4,8,12]) expect(normalizeImageValue(profile,{count:String(count)}).count).toBe(String(count));
 for (const count of [1,5,6,7,10,16]) expect(normalizeImageValue(profile,{count:String(count)}).count).toBe("4");
});

test("Midjourney upgrades stale official gateway size and total-count settings", () => {
 const legacy = defaultModelCapabilityConfig("openai-image", "midjourney-v8.2");
 legacy.image!.size = {parameter:"size",values:["1:1","1024x1024"],default:"1:1",allowCustom:false};
 delete legacy.image!.generationOutputs;
 const config = {channels:[{id:"beefapi",baseUrl:"https://beeftv.app/v1",models:["midjourney-v8.2"],modelProfiles:[{model:"midjourney-v8.2",protocol:"openai-image" as const,capabilityConfig:legacy}]}]};
 const profile = modelCapabilityConfigFor(config,"beefapi::midjourney-v8.2").image!;
 expect(profile.generationOutputs).toEqual([4,8,12]);
 expect(profile.size.presets).toHaveLength(7);
 expect(normalizeImageValue(profile,{size:"1456x816",quality:"2k",count:"8"})).toMatchObject({quality:"auto",count:"8",size:"1456x816"});
});

test("terminal Midjourney task correction updates all cached batch candidates", () => {
 const nodes = ["root","a","b","c","d"].map((id) => ({id,type:CanvasNodeType.Image,title:"MJ",position:{x:0,y:0},width:320,height:320,metadata:{taskId:"failed-task",taskStage:"submission_unknown",generationSubmissionState:"unknown" as const,generationErrorCode:"submission_uncertain"}}));
 const task = {id:"failed-task",type:"canvas_image",status:"failed",stage:"生成失败",errorCode:"invalid_params",error:"图片生成参数不符合要求。请检查模型、尺寸、格式和数量后再试。"} as GenerationTask;
 const corrected = canvasGenerationTaskNodes(nodes,"root",task);
 for (const node of corrected) expect(node.metadata).toMatchObject({taskStage:"生成失败",generationSubmissionState:"accepted",generationErrorCode:"invalid_params",status:"error"});
});
