import { expect, test } from "bun:test";
import { listCanvasWorkflowCapabilities } from "../src/lib/canvas/workflow-capabilities";
import type { WorkflowOperation } from "../src/services/api/canvas-workflows";

test("workflow directory exposes only first-release executable operations", () => {
    const op: WorkflowOperation = { id: "image.crop", name: "图片裁切", version: 1, outputType: "image", inputs: [], fields: [] };
    const capabilities = listCanvasWorkflowCapabilities([op]);
    expect(capabilities.find(c => c.id === "operation.image.crop")?.mode).toBe("direct");
    expect(listCanvasWorkflowCapabilities([{ ...op, unavailableReason: "编码器缺失" }])[0]).toMatchObject({ mode: "unavailable", reason: "编码器缺失" });
    expect(listCanvasWorkflowCapabilities([{...op,id:"image.split"},{...op,id:"new.adapter"}])).toEqual([]);
    const supported = ["image.select","image.describe","image.ai-upscale","video.ai-upscale","video.trim","video.depth"];
    expect(listCanvasWorkflowCapabilities(supported.map(id=>({...op,id}))).map(item=>item.operation?.id)).toEqual(supported);
    expect(listCanvasWorkflowCapabilities([{...op,id:"generate.image"},{...op,id:"generate.video"}])).toEqual([]);
    expect([...new Set(listCanvasWorkflowCapabilities(supported.map(id=>({...op,id}))).map(item=>item.group))].sort()).toEqual(["图片处理","视频处理"]);
});

test("workflow processing labels match canvas action names", () => {
    const expected: Record<string,string> = {"image.crop":"裁切","image.resize":"调整尺寸","image.describe":"反推提示词","image.ai-upscale":"AI超分","video.ai-upscale":"AI超分","video.frame":"关键帧截取","video.audio":"音视频分离","video.trim":"视频剪辑","video.crop":"画面裁切","video.depth":"深度动作捕捉","video.merge":"合并选中视频"};
    const operations = Object.keys(expected).map(id=>({id,name:"旧名称",version:1,outputType:"image" as const,inputs:[],fields:[]}));
    for (const entry of listCanvasWorkflowCapabilities(operations)) {
        expect(entry.name).toBe(expected[entry.operation!.id]);
        expect(entry.operation!.name).toBe(entry.name);
    }
});
