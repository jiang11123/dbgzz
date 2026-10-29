import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasGeneration } from "../../src/pages/canvas/use-canvas-generation";
import { useCanvasGenerationExecutor } from "../../src/pages/canvas/use-canvas-generation-executor";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { recordConfirmedCanvasCommit } from "../../src/services/canvas-operation-journal";
import { cacheResourceObjectUrl } from "../../src/services/resource-blob-cache";
import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "../../src/stores/use-config-store";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";
import { useUserStore } from "../../src/stores/use-user-store";
import type { CanvasNodeData } from "../../src/types/canvas";
import { customerGenerationProject, type CustomerGenerationScenario } from "./customer-generation-scenarios";
import { CanvasNodeGenerationProgress } from "../../src/components/canvas/canvas-node-generation-progress";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { canvasNodeOperation } from "../../src/lib/operation-progress";
import { useOperationProgress } from "../../src/stores/use-operation-progress";

const params = new URLSearchParams(location.search);
const scenario = (params.get("scenario") || "five-images") as CustomerGenerationScenario;
const project = (window as any).__customerProject || customerGenerationProject(scenario);
const noop = () => {};
setActiveUserScope("synthetic-customer");
useUserStore.getState().setHydrated(true);
useUserStore.getState().setStorageMode("local");
const selectedModel = params.has("incompatible-model") ? "kling-v2.6" : "seedance-2.5";
const protocol = params.has("incompatible-model") ? "novita-video" : "newapi-channel-2";
const channel = createModelChannel({ id: "synthetic", name: "Synthetic", baseUrl: location.origin + "/upstream", apiKey: "synthetic-not-a-secret", interfaceType: protocol, models: [selectedModel], modelProfiles: [{ model: selectedModel, protocol }] });
const model = encodeChannelModel(channel.id, selectedModel);
useConfigStore.getState().replaceConfig({ ...defaultConfig, channels: [channel], model, videoModel: model, videoModels: [model], models: [model], videoSeconds: "5", size: "16:9" });
await recordConfirmedCanvasCommit(project);
useCanvasStore.setState({ projects: [project], hydrated: true });
const harness = (window as any).__customer = { settled: false, error: "", messages: [] as string[], controller: undefined as AbortController | undefined, nodes: project.nodes, blocked: [] as Promise<string>[], generate: noop, edit: noop, cancel: noop };
new MutationObserver(changes => {
    for (const change of changes) for (const node of change.addedNodes) {
        if (node instanceof HTMLElement && (node.classList.contains("ant-message-notice") || node.querySelector(".ant-message-notice"))) harness.messages.push(node.textContent || "");
    }
}).observe(document.body, { childList: true, subtree: true });

function Harness() {
    const [nodes, setNodesState] = useState<CanvasNodeData[]>(project.nodes);
    const target = nodes.find(node => node.id === "target")!;
    const preparation = useOperationProgress(state => canvasNodeOperation(state.entries, project.id, target.id, target.metadata?.taskId));
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectionsRef = useRef(project.connections);
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>(update => setNodesState(current => {
        const next = typeof update === "function" ? update(current) : update;
        nodesRef.current = next;
        harness.nodes = next;
        useCanvasStore.getState().updateProject(project.id, { nodes: next });
        return next;
    }), []);
    const generation = useCanvasGeneration({ projectId: project.id, domainProjectId: "synthetic-domain", projectLoaded: params.has("recover"), nodes, nodesRef, setNodes });
    const generate = useCanvasGenerationExecutor({ projectId: project.id, domainProjectId: "synthetic-domain", addedSkills: [], assets: [], nodesRef, connectionsRef, setNodes, setConnections: noop, setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop,
        setRunningNodeId: generation.setRunningNodeId, startGenerationRequest: generation.startGenerationRequest, finishGenerationRequest: generation.finishGenerationRequest, bindGenerationTask: generation.bindGenerationTask, applyGenerationTaskResult: generation.applyGenerationTaskResult });
    harness.generate = async () => {
        harness.settled = false;
        harness.controller = new AbortController();
        const prompt = nodesRef.current.find(node => node.id === "target")!.metadata!.composerContent!;
        try { await generate("target", "video", prompt, { controller: harness.controller }); }
        catch (error) { harness.error = error instanceof Error ? error.message : String(error); }
        finally { harness.settled = true; }
    };
    harness.edit = () => setNodes(current => current.map(node => node.id === "target" ? { ...node, title: "准备期间改过的标题", metadata: { ...node.metadata, composerContent: "准备期间修改的新提示词" } } : node));
    (harness as any).replaceOutput = () => setNodes(current => current.map(node => node.id === "target" ? { ...node, metadata: { ...node.metadata, content: "/api/resources/newer-result/file", storageKey: "resource:newer-result", assetId: "newer-asset", durationMs: 7000 } } : node));
    harness.cancel = () => harness.controller?.abort();
    return <>
        <button onClick={() => void harness.generate()}>生成视频</button>
        <button onClick={() => harness.edit()}>准备期间修改画布</button>
        <button onClick={() => harness.cancel()}>取消准备</button>
        {preparation ? <section aria-label="视频节点"><CanvasNodeGenerationProgress node={target} theme={canvasThemes.dark} operation={preparation} /></section> : null}
        <output data-testid="stage">{nodes.find(node => node.id === "target")?.metadata?.taskStage || "尚未提交"}</output>
        <pre data-testid="snapshot">{JSON.stringify(nodes)}</pre>
    </>;
}
if (params.has("block-cache")) {
    // Queue 16 requests and hold the actual shared scheduler's download slots.
    harness.blocked = Array.from({ length: 16 }, (_, index) => cacheResourceObjectUrl(`resource:blocker-${index}`).catch(() => ""));
}
createRoot(document.getElementById("root")!).render(<App><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider></App>);
