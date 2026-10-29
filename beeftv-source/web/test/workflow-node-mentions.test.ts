import { expect, test } from "bun:test";
import { connectWorkflowPromptReference, normalizeWorkflowNodeMentions, remapWorkflowPromptMentions, validateWorkflowPromptMentions, workflowNodeMentionReferences, workflowPromptDisplayText } from "../src/lib/canvas/workflow-node-mentions";
import type { WorkflowDefinition, WorkflowOperation } from "../src/services/api/canvas-workflows";

const operation: WorkflowOperation = { id: "generate.video", version: 1, name: "生成视频", outputType: "video", fields: [], inputs: [{ id: "referenceVideos", label: "参考视频", mediaType: "video", required: false, multiple: true }, { id: "referenceImages", label: "参考图片", mediaType: "image", required: false, multiple: true }, { id: "prompt", label: "提示词", mediaType: "text", required: false, multiple: true }] };
const definition: WorkflowDefinition = { version: 1, nodes: [{ id: "source", title: "原视频", role: "input", mediaType: "video" }, { id: "depth", title: "动作深度", role: "operation", mediaType: "video", operationId: "video.depth" }, { id: "person", title: "替换人物", role: "input", mediaType: "image" }, { id: "generate", title: "成片", role: "operation", mediaType: "video", operationId: "generate.video", config: { prompt: "背景@视频1 动作@视频2 人物@图片1" } }, { id: "downstream", title: "成片后处理", role: "operation", mediaType: "video" }], edges: [{ fromNodeId: "source", toNodeId: "generate", toPort: "referenceVideos" }, { fromNodeId: "depth", toNodeId: "generate", toPort: "referenceVideos", order: 1 }, { fromNodeId: "person", toNodeId: "generate", toPort: "referenceImages" }, { fromNodeId: "generate", toNodeId: "downstream" }], outputNodeIds: ["generate"] };

test("legacy numbered references show node names and survive renaming", () => {
    const normalized = normalizeWorkflowNodeMentions(definition);
    const prompt = normalized.nodes[3].config!.prompt as string;
    expect(prompt).toBe("背景@[node:source] 动作@[node:depth] 人物@[node:person]");
    expect(workflowPromptDisplayText(prompt, normalized)).toBe("背景@原视频 动作@动作深度 人物@替换人物");
    normalized.nodes = normalized.nodes.map(node => node.id === "source" ? { ...node, title: "背景素材" } : node);
    expect(workflowPromptDisplayText(prompt, normalized)).toContain("@背景素材");
    expect(() => validateWorkflowPromptMentions(normalized)).not.toThrow();
    expect(remapWorkflowPromptMentions(prompt, new Map([["source", "new-id"]]))).toContain("@[node:new-id]");
});

test("mention picker only offers compatible nodes that cannot form a cycle", () => {
    const refs = workflowNodeMentionReferences(definition, "generate", [operation]);
    expect(refs.map(ref => ref.title)).toEqual(["原视频", "动作深度", "替换人物"]);
    expect(refs[0].mentionToken).toBe("@[node:source]");
    expect(refs.every(ref => ref.active)).toBe(true);
});

test("selecting a node creates a reference once and disconnected mentions are rejected", () => {
    const unconnected = { ...definition, edges: definition.edges.filter(edge => edge.fromNodeId !== "person") };
    const connected = connectWorkflowPromptReference(unconnected, "generate", "person", [operation]);
    expect(connected.edges.at(-1)).toMatchObject({ fromNodeId: "person", toNodeId: "generate", toPort: "referenceImages", order: 0 });
    expect(connectWorkflowPromptReference(connected, "generate", "person", [operation])).toBe(connected);
    const normalized = normalizeWorkflowNodeMentions(definition);
    expect(() => validateWorkflowPromptMentions({ ...normalized, edges: unconnected.edges })).toThrow("断开或删除");
});
