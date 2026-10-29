import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasScriptNodeContent } from "@/components/canvas/canvas-script-node";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasNodeType, type CanvasNodeData, type StoryboardColumn } from "@/types/canvas";
import { resolveStoryboardVisibleColumns, storyboardContentColumn } from "@/lib/canvas/canvas-storyboard-columns";

const noop = () => {};
test("a storyboard with image prompts shows its actual content in the canvas", () => {
    const node: CanvasNodeData = { id: "script", type: CanvasNodeType.Script, title: "分镜", width: 920, height: 360, position: { x: 0, y: 0 },
        metadata: { storyboard: { rows: [createStoryboardRow(1, { imageGenerationPrompt: "黄衣外卖员站在电梯前" })], referenceNodeIds: [], visibleColumns: [] } } };
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><CanvasScriptNodeContent node={node} nodes={[node]} pipeline={deriveStoryboardPipelineProgress(node, [node], [])}
        scale={1} mentionReferences={[]} onOpen={noop} onCreateImageNodes={noop} onCreateVideoNodes={noop}
        onGenerateImages={noop} onGenerateVideos={noop} onVideoInputModeChange={noop} onMergeVideos={noop}
        onCreateActionBoards={noop} onRetryBatch={noop} onRetryBatchItem={noop} onStopBatch={noop} onAddRow={noop}
        onRemoveRow={noop} onUpdateRow={noop} onPromptChange={noop} onGenerateScript={noop} onModelChange={noop}
        onShotDurationChange={noop} onShotCountChange={noop} onComposerHeightChange={noop} onConnectStart={noop} onScrollTopChange={noop} /></QueryClientProvider>);
    expect(html).toContain("黄衣外卖员站在电梯前</textarea>");
    expect(html).toContain("图片提示词");
    expect(html).not.toContain('placeholder="黄衣外卖员站在电梯前"');
});

test("default editor columns reveal written content but keep explicit user selections", () => {
    const rows = [createStoryboardRow(1, { imageGenerationPrompt: "首帧", plotDescription: "剧情" })];
    const defaults: StoryboardColumn[] = ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"];
    expect(resolveStoryboardVisibleColumns(defaults, rows)).toEqual([...defaults, "imageGenerationPrompt", "plotDescription"]);
    expect(resolveStoryboardVisibleColumns(defaults, rows, true)).toEqual(defaults);
    const custom: StoryboardColumn[] = ["shotNumber", "dialogue"];
    expect(resolveStoryboardVisibleColumns(custom, rows)).toEqual(custom);
    expect(storyboardContentColumn(rows)).toBe("imageGenerationPrompt");
    expect(storyboardContentColumn([createStoryboardRow(1, { plotDescription: "剧情" })])).toBe("plotDescription");
    expect(storyboardContentColumn([createStoryboardRow(1, { videoMotionPrompt: "抬头", imageGenerationPrompt: "首帧" })])).toBe("videoMotionPrompt");
});
