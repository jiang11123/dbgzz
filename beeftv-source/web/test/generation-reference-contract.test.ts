import { describe, expect, test } from "bun:test";
import { buildNodeGenerationContext, compileNodeGenerationReferences } from "../src/components/canvas/canvas-node-generation";
import { canvasResourceMentionToken, applyCanvasConnectionPromptSync } from "../src/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { AiConfig } from "../src/stores/use-config-store";
import { compileBoundMediaReferences } from "../src/lib/canvas/generation-reference-contract";
import type { Asset } from "../src/stores/use-asset-store";

const config = { model: "ark::seedance-2.0", channels: [{ id: "ark", models: ["seedance-2.0"], modelProfiles: [{ model: "seedance-2.0", protocol: "volcengine-ark-video" }] }] } as AiConfig;
const image = (id: string): CanvasNodeData => ({ id, title: "同名", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "https://example.test/" + id + ".png" } });
const target: CanvasNodeData = { ...image("target"), type: CanvasNodeType.Video, metadata: { composerContent: "test" } };
const nodes = [image("A"), image("B"), target];
const edges = (ids: string[]) => ids.map((id) => ({ id: "edge-" + id, fromNodeId: id, toNodeId: "target" }));
const build = (prompt: string, ids = ["A", "B"]) => buildNodeGenerationContext("target", nodes, edges(ids), prompt, [], true, { preserveMediaBindings: true });
const compile = (prompt: string, ids?: string[]) => compileNodeGenerationReferences(build(prompt, ids), config, "reference_to_video");

describe("bound canvas reference submission", () => {
    test("final IMAGE tables reject conflicting node bindings, including quoted cells", () => {
        for (const quote of ["", "`", '"', "'"]) {
            const prompt = `@[node:B] 在右。\n| IMAGE 1 | ${quote}@[node:A]${quote} |\n| IMAGE 2 | @[node:B] |`;
            const raw = build(prompt);
            expect(() => compileNodeGenerationReferences(raw, config, "reference_to_video")).toThrow("IMAGE 1 对应图片2");
            expect(raw.prompt).toBe(prompt);
            expect(raw.referenceImages.map((item) => item.id)).toEqual(["A", "B"]);
        }
    });

    test("final IMAGE tables accept bindings matching the final order without rewriting saved text", () => {
        const prompt = "@[node:B] 在右。\n| IMAGE 1 | @[node:B] |\n| IMAGE 2 | @[node:A] |";
        const raw = build(prompt);
        const output = compileNodeGenerationReferences(raw, config, "reference_to_video");
        expect(output.referenceImages.map((item) => item.id)).toEqual(["B", "A"]);
        expect(output.prompt).toBe("@图片1 在右。\n| IMAGE 1 | @图片1 |\n| IMAGE 2 | @图片2 |");
        expect(raw.prompt).toBe(prompt);
    });

    test("final IMAGE tables resolve unique display names after ordering, not connection positions", () => {
        const graph = [{ ...nodes[0]!, title: "甲" }, { ...nodes[1]!, title: "乙" }, target];
        const prepare = (name: string) => buildNodeGenerationContext("target", graph, edges(["A", "B"]), `@[node:B] 在右。\n| IMAGE 1 | @${name} |`, [], true, { preserveMediaBindings: true });
        const correct = prepare("乙");
        expect(compileNodeGenerationReferences(correct, config, "reference_to_video").referenceImages.map((item) => item.id)).toEqual(["B", "A"]);
        expect(() => compileNodeGenerationReferences(prepare("甲"), config, "reference_to_video")).toThrow("IMAGE 1 对应图片2");
    });

    test("final IMAGE tables validate library asset identity", () => {
        const asset = { id: "library-face", kind: "image", title: "素材脸", data: { mimeType: "image/png", dataUrl: "https://example.test/face.png" } } as Asset;
        const prepare = (slot: number) => buildNodeGenerationContext("target", nodes, edges(["B"]), `@[node:B] 在右。\n| IMAGE ${slot} | @[asset:library-face] |`, [asset], true, { preserveMediaBindings: true });
        expect(() => compileNodeGenerationReferences(prepare(1), config, "reference_to_video")).toThrow("IMAGE 1 对应图片2");
        expect(compileNodeGenerationReferences(prepare(2), config, "reference_to_video").prompt).toContain("| IMAGE 2 | @图片2 |");
    });

    test("final IMAGE checks include tables added after input assembly", () => {
        const raw = build("@[node:B] 在右，@[node:A] 在左");
        const prepared = { ...raw, prompt: `${raw.prompt}\n| IMAGE 1 | @[node:A] |` };
        expect(() => compileNodeGenerationReferences(prepared, config, "reference_to_video")).toThrow("IMAGE 1 对应图片2");
    });

    test("final IMAGE tables retain legacy drawing and photo slot meanings", () => {
        const drawing = { ...image("sketch"), type: CanvasNodeType.Drawing, metadata: { drawingId: "drawing-id" } };
        const prompt = "| IMAGE 1 | @绘图1 |\n| IMAGE 2 | @图片1 |";
        const raw = buildNodeGenerationContext("target", [drawing, image("A"), target], edges(["sketch", "A"]), prompt, [], true, { preserveMediaBindings: true });
        const output = compileNodeGenerationReferences(raw, config, "reference_to_video");
        expect(output.referenceImages.map((item) => item.id)).toEqual(["sketch", "A"]);
        expect(output.prompt).toBe(prompt);
    });

    test("Seedance newapi-channel-2 orders bound references across connection permutations", () => {
        const channelConfig = { model: "custom::seedance-2.0", channels: [{ id: "custom", models: ["seedance-2.0"], modelProfiles: [{ model: "seedance-2.0", protocol: "newapi-channel-2" }] }] } as AiConfig;
        for (const ids of [["A", "B"], ["B", "A"]]) {
            const raw = build("@[node:B] 在右，@[node:A] 在左", ids);
            const output = compileNodeGenerationReferences(raw, channelConfig, "reference_to_video");
            expect(output.referenceImages.map((item) => item.id)).toEqual(["B", "A"]);
            expect(output.prompt).toBe("@图片1 在右，@图片2 在左");
        }
        const raw = build("@[node:B] 在右，@[node:A] 在左");
        for (const [current, operation] of [[channelConfig, "image_to_video"], [{ ...channelConfig, taskWorkflowProvider: "runninghub" }, "reference_to_video"]] as const) {
            expect(compileNodeGenerationReferences(raw, current as AiConfig, operation).referenceImages.map((item) => item.id)).toEqual(["A", "B"]);
        }
    });

    test("the selected file and final prompt stay identical across connection permutations", () => {
        const prompt = "@[node:B] 在右，@[node:A] 在左。@[node:B] 先说话。";
        for (const ids of [["A", "B"], ["B", "A"]]) {
            const raw = build(prompt, ids);
            expect(raw.prompt).toBe(prompt);
            const output = compileNodeGenerationReferences(raw, config, "reference_to_video");
            expect(output.referenceImages.map((item) => item.id)).toEqual(["B", "A"]);
            expect(output.prompt).toBe("@图片1 在右，@图片2 在左。@图片1 先说话。");
            expect(raw.prompt).toBe(prompt);
            expect(raw.referenceImages.map((item) => item.id)).toEqual(ids);
        }
    });

    test("new editor selections store node identity instead of the current shelf label", () => {
        const reference = { id: "A", nodeId: "A", kind: "image" as const, label: "图片2", title: "同名", active: true };
        expect(canvasResourceMentionToken(reference)).toBe("@[node:A]");
        const node = { ...target, metadata: { composerContent: "@[node:A] 在左，@[node:B] 在右" } };
        const graph = [nodes[0]!, nodes[1]!, node];
        const synced = applyCanvasConnectionPromptSync(graph, edges(["A", "B"]), graph, edges(["B", "A"]));
        expect(synced.find((item) => item.id === "target")?.metadata?.composerContent).toBe(node.metadata.composerContent);
        const restored = JSON.parse(JSON.stringify(synced)) as CanvasNodeData[];
        expect(restored.find((item) => item.id === "target")?.metadata?.composerContent).toBe(node.metadata.composerContent);
    });

    test("legacy ordinal prose and IMAGE tables keep their original slot contract", () => {
        for (const suffix of ["第一张参考图中的人物始终在左边。", "The first image stays on the left.", "| IMAGE 1 | @图片1 |"] ) {
            const prompt = "@图片2 在右，@图片1 在左。" + suffix;
            const output = compile(prompt);
            expect(output.referenceImages.map((item) => item.id)).toEqual(["A", "B"]);
            expect(output.prompt).toBe(prompt);
        }
        const mixed = compile("@[node:B] 在右，@图片1 在左。");
        expect(mixed.referenceImages.map((item) => item.id)).toEqual(["A", "B"]);
        expect(mixed.prompt).toBe("@图片2 在右，@图片1 在左。");
    });

    test("missing selected references fail before a provider request", () => {
        expect(() => compile("@[node:deleted] 在左")).toThrow("没有对应的画布资源");
        const context = build("@[node:B] 在右");
        context.referenceImages = [];
        expect(() => compileNodeGenerationReferences(context, config, "reference_to_video")).toThrow("已不可用");
        context.prompt = "@[node:injected] 在右";
        expect(() => compileNodeGenerationReferences(context, config, "reference_to_video")).toThrow("没有对应的素材");
    });

    test("first/last frames, other models and fixed workflow slots preserve their ordering", () => {
        const raw = build("@[node:B] 在右，@[node:A] 在左");
        for (const [current, operation] of [
            [config, "image_to_video"],
            [{ ...config, taskWorkflowProvider: "runninghub" }, "reference_to_video"],
            [{ ...config, model: "h3" }, "reference_to_video"],
        ] as const) {
            const output = compileNodeGenerationReferences(raw, current as AiConfig, operation);
            expect(output.referenceImages.map((item) => item.id)).toEqual(["A", "B"]);
            expect(output.prompt).toBe("@图片2 在右，@图片1 在左");
        }
    });

    test("character bindings use final media IDs after ordering", () => {
        const raw = build("@[node:B] 在右，@[node:A] 在左");
        raw.characterReferenceBindings = [{ role: 1, name: "甲", imageIds: ["A"], audioIds: [] }];
        const output = compileNodeGenerationReferences(raw, config, "reference_to_video");
        expect(output.prompt).toContain("@角色1 与「甲」指同一角色。该角色外观参考 @图片2");
    });

    test("mixed image/drawing, video and audio references share their final per-kind numbering", () => {
        const baseImage = { name: "test.png", type: "image/png", dataUrl: "" };
        const output = compileBoundMediaReferences({
            prompt: "@[node:drawing] 环境，@[asset:face] 人物，@[node:v2] 动作，@[node:v1] 机位，@[node:a2] 声音，@[node:a1] 环境音",
            referenceImages: [{ ...baseImage, id: "face" }, { ...baseImage, id: "drawing" }],
            referenceVideos: [{ id: "v1", name: "1", type: "video/mp4", url: "" }, { id: "v2", name: "2", type: "video/mp4", url: "" }],
            referenceAudios: [{ id: "a1", name: "1", type: "audio/wav", url: "" }, { id: "a2", name: "2", type: "audio/wav", url: "" }],
            boundMediaMentions: [
                { token: "@[node:drawing]", kind: "image" as const, referenceId: "drawing" },
                { token: "@[asset:face]", kind: "image" as const, referenceId: "face" },
                ...["v1", "v2"].map((id) => ({ token: `@[node:${id}]`, kind: "video" as const, referenceId: id })),
                ...["a1", "a2"].map((id) => ({ token: `@[node:${id}]`, kind: "audio" as const, referenceId: id })),
            ],
        }, true);
        expect(output.referenceImages.map((item) => item.id)).toEqual(["drawing", "face"]);
        expect(output.referenceVideos.map((item) => item.id)).toEqual(["v2", "v1"]);
        expect(output.referenceAudios.map((item) => item.id)).toEqual(["a2", "a1"]);
        expect(output.prompt).toBe("@图片1 环境，@图片2 人物，@视频1 动作，@视频2 机位，@音频1 声音，@音频2 环境音");
    });

    test("explicit text input retains bindings nested inside its content", () => {
        const note = { ...image("note"), type: CanvasNodeType.Text, metadata: { content: "@[node:B] 在右，@[node:A] 在左" } };
        const graph = [...nodes, note];
        const raw = buildNodeGenerationContext("target", graph, [...edges(["A", "B"]), { id: "note-edge", fromNodeId: "note", toNodeId: "target" }], "@[node:note]", [], true, { preserveMediaBindings: true });
        const output = compileNodeGenerationReferences(raw, config, "reference_to_video");
        expect(output.referenceImages.map((item) => item.id)).toEqual(["B", "A"]);
        expect(output.prompt).toContain("@图片1 在右，@图片2 在左");
    });
});
