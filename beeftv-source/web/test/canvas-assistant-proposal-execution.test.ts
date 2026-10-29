import { expect, test } from "bun:test";
import { ApiError } from "@/services/api/request";
import { buildConfirmedGenerationConfig, executeAssistantProposal } from "@/pages/canvas/canvas-assistant-proposal-execution";
import { AssistantProposalBlockedError, type AssistantProposalBlockedReason } from "@/pages/canvas/canvas-assistant-proposal-snapshot";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { buildGenerationConfig, runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "@/services/api/task-center";
import { backendProviderConfig } from "@/services/api/generation-task";

const node: CanvasNodeData = { id: "node-1", title: "Image", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "test image" } };
const proposal = { proposalId: "proposal-1", kind: "image" as const, nodeIds: [node.id], model: "Confirmed", modelKey: "channel::confirmed" };
function input(overrides: Partial<Parameters<typeof executeAssistantProposal>[0]> = {}) {
    return { proposal, nodes: [node], claims: new Set<string>(), isHandled: false,
        prepare: async () => structuredClone({ nodes: overrides.nodes ?? [node], connections: [], config: defaultConfig, assets: [], skills: [] }),
        generate: async () => {}, markHandled: () => {}, notify: () => {}, ...overrides };
}

test("F02: confirmed proposal model reaches the generation execution boundary", async () => {
    let options: unknown;
    await executeAssistantProposal(input({ generate: async (_id, _mode, _prompt, received) => { options = received; } }));
    expect(options).toMatchObject({ confirmedModelKey: proposal.modelKey, clientOperationId: `proposal:${proposal.proposalId}:${node.id}` });
});

test("F04: a validation early return does not claim generation started", async () => {
    const handled: string[] = [];
    await executeAssistantProposal(input({ markHandled: (id) => { handled.push(id); } }));
    expect(handled).toEqual([]);
});

test("proposal read failures are not reported as proven input drift", async () => {
    const notices: string[] = [];
    let submissions = 0;
    const args = input({ prepare: async () => { throw new Error("offline"); }, generate: async () => { submissions++; }, notify: text => { notices.push(text); } });
    await executeAssistantProposal(args);
    expect(submissions).toBe(0);
    expect(args.claims.size).toBe(0);
    expect(notices).toEqual(["无法核对提案的最新内容，请检查连接后重试。"]);
});

test("a revoked continuation intent asks for a fresh proposal without submitting generation", async () => {
    const notices: string[] = [];
    let submissions = 0;
    const args = input({ prepare: async () => { throw new ApiError("server detail", {status:409,reason:"continuation_intent_changed"}); }, generate: async () => { submissions++; }, notify: text => {notices.push(text);} });
    await executeAssistantProposal(args);
    expect(submissions).toBe(0);
    expect(args.claims.size).toBe(0);
    expect(notices).toEqual(["要求已更新，请让助手重新提出生成方案。"]);
});

const blockedCopy: [AssistantProposalBlockedReason, string][] = [
    ["canvas_saving", "画布还在保存。稍等几秒再点生成。"],
    ["canvas_conflict", "画布有未解决的版本冲突。请在顶部保存状态中使用最新版本，再让助手重新提出方案。"],
    ["settings_unsaved", "生成设置还没保存。保存后再点生成。"],
    ["canvas_changed", "画布在提出方案后改过。请让助手重新提出方案。"],
    ["settings_changed", "生成设置在提出方案后改过。请让助手重新提出方案。"],
    ["content_mismatch", "画布显示的内容和已保存的不一致。请重新打开这个画布，再让助手重新提出方案。"],
    ["invalid_source", "这项方案缺少核对信息。请让助手重新提出方案。"],
];
for (const [reason, copy] of blockedCopy) test(`blocked proposal (${reason}) tells the user why and what to do`, async () => {
    const notices: string[] = [];
    let submissions = 0;
    const args = input({ prepare: async () => { throw new AssistantProposalBlockedError(reason); }, generate: async () => { submissions++; }, notify: text => { notices.push(text); } });
    await executeAssistantProposal(args);
    expect(submissions).toBe(0);
    expect(args.claims.size).toBe(0);
    expect(notices).toEqual([copy]);
});

const task: GenerationTask = { id: "task-1", type: "canvas_image", status: "queued", prompt: "test image", createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" };

test("F04: only an accepted task receipt marks handled, before completion and only once", async () => {
    const events: string[] = [];
    await executeAssistantProposal(input({
        markHandled: () => { events.push("handled"); },
        generate: async (_id, _mode, _prompt, options) => {
            expect(events).toEqual([]);
            await runCanvasGenerationTaskToConsumer({ projectId: "test", nodeId: node.id, mode: "image", prompt: "test", config: defaultConfig }, {
                prepareTarget: async () => undefined,
                bindTask: (receipt) => options?.onTaskUpdate?.(receipt),
                consumeTask: async () => { events.push("consumed"); },
                runTask: async ({ onTaskCreated }) => {
                    onTaskCreated?.(task);
                    expect(events).toEqual(["handled"]);
                    onTaskCreated?.({ ...task, status: "succeeded" });
                    return { images: [] };
                },
            });
        },
    }));
    expect(events).toEqual(["handled", "consumed"]);
});

test("F04: submission rejection is reported without handled state or an unhandled rejection", async () => {
    const handled: string[] = [];
    const notices: string[] = [];
    const args = input({ generate: async () => { throw new Error("create task rejected"); }, markHandled: (id) => { handled.push(id); }, notify: (text) => { notices.push(text); } });
    await executeAssistantProposal(args);
    expect(handled).toEqual([]);
    expect(args.claims.size).toBe(0);
    expect(notices).toHaveLength(1);
});

test("same-window rapid clicks and stale renders cannot resubmit an accepted proposal", async () => {
    let submissions = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const args = input({ generate: async (_id, _mode, _prompt, options) => {
        submissions++;
        await pending;
        options?.onTaskUpdate?.(task);
    } });
    const first = executeAssistantProposal(args);
    await executeAssistantProposal(args);
    expect(submissions).toBe(1);
    release();
    await first;
    await executeAssistantProposal(args);
    expect(submissions).toBe(1);
});

test("a persisted handled proposal does not submit again", async () => {
    let submissions = 0;
    await executeAssistantProposal(input({ isHandled: true, generate: async () => { submissions++; } }));
    expect(submissions).toBe(0);
});

test("runtime proposals with missing, null or non-string modelKey fail closed without throwing", async () => {
    let submissions = 0;
    let handled = 0;
    const notices: string[] = [];
    for (const modelKey of [undefined, null, 42, {}]) {
        await executeAssistantProposal(input({
            proposal: { ...proposal, modelKey } as unknown as typeof proposal,
            generate: async () => { submissions++; },
            markHandled: () => { handled++; },
            notify: (text) => { notices.push(text); },
        }));
    }
    expect(submissions).toBe(0);
    expect(handled).toBe(0);
    expect(notices).toHaveLength(4);
});

test("missing nodes or blank model reject the whole proposal before submitting", async () => {
    let submissions = 0;
    for (const invalid of [{ ...proposal, nodeIds: [node.id, "deleted"] }, { ...proposal, nodeIds: [] }, { ...proposal, modelKey: " " }]) {
        await executeAssistantProposal(input({ proposal: invalid, generate: async () => { submissions++; } }));
    }
    expect(submissions).toBe(0);
});

test("duplicate node IDs submit once; a failed receipt does not claim started or allow replay", async () => {
    let submissions = 0;
    const handled: string[] = [];
    const args = input({ proposal: { ...proposal, nodeIds: [node.id, node.id] }, markHandled: (id) => { handled.push(id); }, generate: async (_id, _mode, _prompt, options) => {
        submissions++;
        options?.onTaskUpdate?.({ ...task, status: "failed" });
    } });
    await executeAssistantProposal(args);
    await executeAssistantProposal(args);
    expect(submissions).toBe(1);
    expect(handled).toEqual([]);
});

test("partial acceptance is reported and never replays the accepted targets", async () => {
    const notices: string[] = [];
    const submissions: string[] = [];
    const args = input({
        nodes: [node, { ...node, id: "node-2" }],
        proposal: { ...proposal, nodeIds: [node.id, "node-2"] },
        notify: (text) => { notices.push(text); },
        generate: async (id, _mode, _prompt, options) => {
            submissions.push(id);
            if (id === node.id) options?.onTaskUpdate?.(task);
            else throw new Error("submission failed");
        },
    });
    await executeAssistantProposal(args);
    expect(notices[0]).toContain("1/2");
    await executeAssistantProposal(args);
    expect(submissions).toEqual([node.id, "node-2"]);
});

function modelConfig(): AiConfig {
    const models = ["channel::image-a", "channel::image-b"];
    return {
        ...defaultConfig, model: models[0], imageModel: models[0], imageModels: models, models,
        channels: [{ id: "channel", name: "Test", baseUrl: "https://example.invalid", apiKey: "", apiFormat: "openai", models: ["image-a", "image-b"], modelProfiles: ["image-a", "image-b"].map((model) => ({ model, displayName: model, capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 1 })) }],
    };
}

test("confirmed generation preserves the channel's explicit reference asset origin", () => {
    const config = modelConfig();
    config.channels![0].referenceAssetOrigin = "https://assets.example.com";
    const confirmed = buildConfirmedGenerationConfig(config, node, "image", undefined, config.imageModel);
    expect(backendProviderConfig(confirmed, "image").referenceAssetOrigin).toBe("https://assets.example.com");
});

test("F02: changed defaults or node model stop before the paid execution boundary", async () => {
    const config = modelConfig();
    const confirmedModelKey = config.imageModel;
    expect(buildConfirmedGenerationConfig(config, node, "image", undefined, confirmedModelKey).model).toBe(confirmedModelKey);
    let paidExecutions = 0;
    for (const [currentConfig, currentNode] of [
        [{ ...config, imageModel: "channel::image-b" }, node],
        [config, { ...node, metadata: { ...node.metadata, model: "channel::image-b" } }],
    ] as const) {
        await executeAssistantProposal(input({
            proposal: { ...proposal, modelKey: confirmedModelKey },
            nodes: [currentNode],
            generate: async (_id, mode, _prompt, options) => {
                buildConfirmedGenerationConfig(currentConfig, currentNode, mode, undefined, options?.confirmedModelKey);
                paidExecutions++;
            },
        }));
    }
    expect(paidExecutions).toBe(0);
});

test("F02: reference-driven compatibility fallback is rejected after re-resolution", () => {
    const models = ["channel::cinema-text", "channel::cinema-image"];
    const config: AiConfig = {
        ...defaultConfig, model: models[0], videoModel: models[0], videoModels: models, models,
        channels: [{ id: "channel", name: "Test", baseUrl: "https://example.invalid", apiKey: "", apiFormat: "openai", models: ["cinema-text", "cinema-image"], modelProfiles: ["cinema-text", "cinema-image"].map((model, index) => {
            const capabilityConfig = defaultModelCapabilityConfig(undefined, model);
            capabilityConfig.video!.operations = [index ? "image_to_video" : "text_to_video"];
            capabilityConfig.video!.references.maxImages = index;
            return { model, displayName: "Cinema", capability: "video", billingMode: "per_second", unitPriceMicrocredits: 1, capabilityConfig };
        }) }],
    };
    const videoNode = { ...node, type: CanvasNodeType.Video };
    const requirements = { capability: "video" as const, input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } };
    expect(buildGenerationConfig(config, videoNode, "video", requirements).model).toBe(models[1]);
    expect(() => buildConfirmedGenerationConfig(config, videoNode, "video", requirements, models[0])).toThrow("请让助手重新提出生成方案");
    expect(buildConfirmedGenerationConfig(config, videoNode, "video", requirements).model).toBe(models[1]);
});

test("F02: workflow substitution and blank confirmation keys fail closed", () => {
    const config = modelConfig();
    expect(() => buildConfirmedGenerationConfig(config, node, "image", undefined, "")).toThrow();
    const workflow = { ...node, type: CanvasNodeType.Config, metadata: { workflowProvider: "runninghub" as const } };
    expect(() => buildConfirmedGenerationConfig(config, workflow, "image", undefined, config.imageModel)).toThrow();
});

test("a round the server reports as undone never reads or submits the proposal", async () => {
    let prepared = 0;
    let submissions = 0;
    const notices: string[] = [];
    const args = input({
        confirmRunnable: async () => "这一轮已撤销，不会生成。",
        prepare: async () => { prepared++; throw new Error("must not read"); },
        generate: async () => { submissions++; },
        notify: text => { notices.push(text); },
    });
    await executeAssistantProposal(args);
    expect(prepared).toBe(0);
    expect(submissions).toBe(0);
    expect(args.claims.size).toBe(0);
    expect(notices).toEqual(["这一轮已撤销，不会生成。"]);
});

test("a confirmed round continues to the normal submission path", async () => {
    let submissions = 0;
    await executeAssistantProposal(input({ confirmRunnable: async () => null, generate: async () => { submissions++; } }));
    expect(submissions).toBe(1);
});

test("a second click while the first is still being checked does not check or submit again", async () => {
    let prepares = 0;
    let submissions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const notices: string[] = [];
    const args = input({
        prepare: async () => { prepares++; await gate; return { nodes: [node], connections: [], config: defaultConfig, assets: [], skills: [] }; },
        generate: async (_id, _mode, _prompt, options) => { submissions++; options?.onTaskUpdate?.(task); },
        notify: (text) => { notices.push(text); },
    });
    const first = executeAssistantProposal(args);
    await executeAssistantProposal(args);
    expect(prepares).toBe(1);
    expect(notices).toEqual(["这项提案已提交或正在提交，请在任务列表查看进度。"]);
    release();
    await first;
    expect(submissions).toBe(1);
});

test("switching canvas or account while checking submits nothing and lets the user confirm again after switching back", async () => {
    let owned = true;
    let submissions = 0;
    const notices: string[] = [];
    const args = input({
        prepare: async () => { owned = false; return structuredClone({ nodes: [node], connections: [], config: defaultConfig, assets: [], skills: [] }); },
        generate: async () => { submissions++; },
        stillOwns: () => owned,
        notify: (text) => { notices.push(text); },
    });
    await executeAssistantProposal(args);
    expect(submissions).toBe(0);
    expect(args.claims.size).toBe(0);
    expect(notices).toEqual(["画布或账号已切换，未提交生成。请重新确认提案。"]);
    owned = true;
    await executeAssistantProposal({ ...args, prepare: async () => structuredClone({ nodes: [node], connections: [], config: defaultConfig, assets: [], skills: [] }), generate: async (_id, _mode, _prompt, options) => { submissions++; options?.onTaskUpdate?.(task); } });
    expect(submissions).toBe(1);
});

test("partially started proposals are marked handled exactly once and keep the claim so nothing is resubmitted", async () => {
    const handled: string[] = [];
    const args = input({
        nodes: [node, { ...node, id: "node-2" }, { ...node, id: "node-3" }],
        proposal: { ...proposal, nodeIds: [node.id, "node-2", "node-3"] },
        markHandled: (id) => { handled.push(id); },
        generate: async (id, _mode, _prompt, options) => {
            if (id === "node-3") throw new Error("submission failed");
            options?.onTaskUpdate?.({ ...task, id: `task-${id}` });
            options?.onTaskUpdate?.({ ...task, id: `task-${id}`, status: "running" });
        },
    });
    await executeAssistantProposal(args);
    expect(handled).toEqual([proposal.proposalId]);
    expect(args.claims.has(proposal.proposalId)).toBe(true);
});
