import { inspectAgentImage } from "./agent-image-preview";
import { runBackendToolGenerationTask } from "./api/generation-task";
import { runArtCritiquePipeline, type ArtCritiquePipelineOptions } from "@/lib/art-critique/pipeline";
import { artCritiqueSourceFingerprint, isArtCritiqueImageInput } from "@/lib/art-critique/contracts";
import type { CanvasNodeData } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";
import { getActiveUserScope } from "@/lib/user-scope";

export const ART_CRITIQUE_MAX_MODEL_CALLS = 9;

// One execution boundary for manual UI and future approved Agent runs.
// The executor may be replaced by an approval-aware task submitter; parsing stays in the pipeline.
export async function executeArtCritique(input: {
    nodeId: string;
    runId: string;
    source: CanvasNodeData;
    config: AiConfig;
    signal: AbortSignal;
    onTaskCreated: (stage: string, taskId: string) => void;
    onStage?: ArtCritiquePipelineOptions["onStage"];
    onDraftReport?: ArtCritiquePipelineOptions["onDraftReport"];
    submitStage?: typeof runBackendToolGenerationTask;
}, dependencies = { inspectImage: inspectAgentImage, runTask: runBackendToolGenerationTask, runPipeline: runArtCritiquePipeline }) {
    if (!input.nodeId || !input.runId || !isArtCritiqueImageInput(input.source)) throw new Error("分析需要真实目标节点、执行标识和已有图片");
    const scope = getActiveUserScope();
    const assertLive = () => {
        if (input.signal.aborted || getActiveUserScope() !== scope) throw new DOMException("分析已停止或账号已切换", "AbortError");
    };
    assertLive();
    const content = input.source.metadata?.content || input.source.metadata?.previewContent || "";
    const image = await dependencies.inspectImage({ storageKey: input.source.metadata?.storageKey, ...(content.startsWith("data:") ? { dataUrl: content } : { url: content }), name: input.source.title }, "original");
    assertLive();
    const calledStages = new Set<string>();
    return dependencies.runPipeline(input.config, { dataUrl: image.storageKey, title: input.source.title, sourceFingerprint: artCritiqueSourceFingerprint(input.source) }, {
        signal: input.signal,
        onStage: (stage) => { assertLive(); input.onStage?.(stage); },
        onDraftReport: (report) => { assertLive(); input.onDraftReport?.(report); },
        requestStage: async ({ config, messages, tool, toolName, signal }) => {
            assertLive();
            if (calledStages.has(toolName) || calledStages.size >= ART_CRITIQUE_MAX_MODEL_CALLS) throw new Error("分析阶段重复或超过本次调用数量上限");
            calledStages.add(toolName);
            const result = await (input.submitStage || dependencies.runTask)({
                config, messages, tools: [tool], toolChoice: { type: "function", name: toolName },
                prompt: `图片审美分析：${toolName}`, signal,
                metadata: { source: "art-critique", nodeId: input.nodeId, runId: input.runId, stage: toolName },
                // A task can be accepted while the user stops observing; retain that receipt.
                onTaskCreated: (task) => { if (getActiveUserScope() === scope) input.onTaskCreated(toolName, task.id); },
            });
            assertLive();
            return result;
        },
    });
}
