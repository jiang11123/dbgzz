import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasScriptEditor, CanvasScriptNodeContent } from "../../src/components/canvas/canvas-script-node";
import { deriveStoryboardPipelineProgress } from "../../src/lib/canvas/canvas-storyboard-progress";
import { getAntThemeConfig } from "@/lib/app-theme";
import { createStoryboardRow } from "../../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const noop = () => {};
const client = new QueryClient();
function Harness() {
    const [heightWrites, setHeightWrites] = useState(0);
    const [node, setNode] = useState<CanvasNodeData>({
        id: "script", type: CanvasNodeType.Script, title: "分镜", position: { x: 0, y: 0 }, width: 920, height: 360,
        metadata: { storyboard: { referenceNodeIds: [], visibleColumns: ["shotNumber", "durationSeconds", "plotDescription", "dialogue", "imageGenerationPrompt", "videoMotionPrompt", "assets"], rows: [1, 2].map((number) => createStoryboardRow(number, { durationSeconds: 5, plotDescription: "黄衣外卖员站在电梯前", imageGenerationPrompt: "楼层显示13", videoMotionPrompt: "缓慢抬头" })) } },
    });
    return <ConfigProvider theme={getAntThemeConfig(location.search.includes("dark"))}><App><QueryClientProvider client={client}>
        {location.search.includes("node") ? <div style={{ width: 920, height: 500 }}>
            <output data-testid="height-writes">{heightWrites}</output>
            <CanvasScriptNodeContent node={node} nodes={[node]} pipeline={deriveStoryboardPipelineProgress(node, [node], [])}
                scale={1} mentionReferences={[]} onOpen={noop} onCreateImageNodes={noop} onCreateVideoNodes={noop}
                onGenerateImages={noop} onGenerateVideos={noop} onVideoInputModeChange={noop} onMergeVideos={noop}
                onCreateActionBoards={noop} onRetryBatch={noop} onRetryBatchItem={noop} onStopBatch={noop} onAddRow={noop}
                onRemoveRow={noop} onUpdateRow={noop} onPromptChange={(composerContent) => setNode(current => ({ ...current, metadata: { ...current.metadata, composerContent } }))}
                onGenerateScript={noop} onModelChange={noop} onShotDurationChange={noop} onShotCountChange={noop}
                onComposerHeightChange={height => { setHeightWrites(count => count + 1); setNode(current => ({ ...current, metadata: { ...current.metadata, storyboardComposerHeight: height } })); }}
                onConnectStart={noop} onScrollTopChange={noop} />
        </div> : <CanvasScriptEditor node={node} nodes={[node]} open onClose={noop}
            onUpdateRows={(rows) => setNode({ ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows } } })}
            onVisibleColumnsChange={noop} onGenerateImages={noop} onGenerateVideos={noop} onVideoInputModeChange={noop} />}
    </QueryClientProvider></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
