import { canvasAppearanceForTheme } from "../../src/lib/canvas/canvas-appearance";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../src/types/canvas";

// Synthetic reconstructions of the two reported input shapes. The exported
// diagnostics did not include the click or graph, so these are separate cases.
export type CustomerGenerationScenario = "five-images" | "video-image" | "missing-audio-duration" | "character";

export function customerGenerationProject(scenario: CustomerGenerationScenario) {
    const refs: CanvasNodeData[] = [];
    const add = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}) => refs.push({
        id, type, title: id, position: { x: refs.length * 340, y: 0 }, width: 320, height: 180,
        metadata: { content: `/api/resources/${id}/file`, storageKey: `resource:${id}`, status: "success", naturalWidth: 1280, naturalHeight: 720, ...metadata },
    });
    let prompt = "让 @图片1 在画面中缓慢移动";
    if (scenario === "five-images") {
        for (let index = 1; index <= 5; index++) add(`image-${index}`, CanvasNodeType.Image);
        prompt = "参考 @图片1 @图片2 @图片3 @图片4 @图片5，镜头缓慢推进";
    } else if (scenario === "video-image") {
        add("video-1", CanvasNodeType.Video, { durationMs: 2500 });
        add("image-1", CanvasNodeType.Image);
        prompt = "保留 @视频1 的运动，使用 @图片1 的构图";
    } else if (scenario === "missing-audio-duration") {
        add("image-1", CanvasNodeType.Image);
        add("audio-1", CanvasNodeType.Audio, { durationMs: 0, mimeType: "audio/wav" });
        prompt = "参考 @图片1，以 @音频1 配音";
    } else {
        refs.push({ id: "character-1", type: CanvasNodeType.Config, title: "测试角色", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { workflowKind: "character", characterAssetId: "character-asset", characterVersionId: "character-v1" } });
        prompt = "让 @角色1 在画面中缓慢移动";
    }
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Video, title: "客户生成场景", position: { x: 0, y: 300 }, width: 320, height: 180,
        metadata: { content: "/api/resources/previous-result/file", storageKey: "resource:previous-result", status: "success", nodeRole: "generator", generationResultPlacement: "replace-node", composerContent: prompt, prompt } };
    const connections: CanvasConnection[] = refs.map(node => ({ id: `edge-${node.id}`, fromNodeId: node.id, toNodeId: target.id }));
    return { id: "customer-scenario", revision: 1, title: "Synthetic customer generation", createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", nodes: [...refs, target], connections,
        chatSessions: [], activeChatId: null, appearance: canvasAppearanceForTheme("light"), backgroundMode: "grid" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
}
