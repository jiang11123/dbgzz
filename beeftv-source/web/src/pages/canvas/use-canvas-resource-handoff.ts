import { createElement, useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button } from "antd";
import type { SetURLSearchParams } from "react-router";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { resolveProjectCanvasStyle } from "@/components/canvas/canvas-style-picker-modal";
import { refreshCanvasCharacterReferenceNodes } from "@/lib/canvas/canvas-character-reference";
import { canvasAssetHandoffIds, consumeCanvasAssetHandoff } from "@/lib/canvas/canvas-asset-handoff";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { isUserScopeAbandonedError } from "@/lib/user-scope-guard";
import { createStyleProfileSnapshot, resolveStyleProfile, serializeStyleProfile } from "@/lib/canvas/style-profile";
import { getProject } from "@/services/api/projects";
import { queryGenerationTask, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { loadAssetsForUse } from "@/services/local-workspace-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

import { readOwnedCanvasNodes, runOwnedCanvasEnsureQueue, runOwnedCanvasPageCommit, useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { applyArchivedCanvasNodeAssets, CANVAS_HANDOFF_PERSIST_FAILED_MESSAGE, commitOwnedCanvasAssetHandoff, rebaseCreatedCanvasNodes } from "./canvas-resource-handoff-commit";
import { canvasGenerationFailureMetadata } from "./canvas-generation-failure";
import { linkedFolderPresentation, planCanvasHandoffEffect, resolveCanvasAssetHandoffPlan } from "./canvas-resource-handoff-plan";

const NODE_STATUS_SUCCESS = "success" as const;

type UseCanvasResourceHandoffOptions = {
    projectId: string;
    linkedProjectId: string;
    projectLoaded: boolean;
    assets: Asset[];
    assetsHydrated: boolean;
    nodesRef: { current: CanvasNodeData[] };
    searchParams: URLSearchParams;
    setSearchParams: SetURLSearchParams;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    getCanvasCenter: () => Position;
    createHandoffNodes: (payloads: InsertAssetPayload[], origin: Position) => Promise<CanvasNodeData[]>;
    applyGenerationTaskResult: (nodeId: string, task: GenerationTask, isNodeOwned?: () => boolean) => Promise<void>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
};

export function useCanvasResourceHandoff({
    projectId,
    linkedProjectId,
    projectLoaded,
    assets,
    assetsHydrated,
    nodesRef,
    searchParams,
    setSearchParams,
    setNodes,
    getCanvasCenter,
    createHandoffNodes,
    applyGenerationTaskResult,
    startGenerationRequest,
    finishGenerationRequest,
}: UseCanvasResourceHandoffOptions) {
    const { message } = App.useApp();
    const assetHandoffRef = useRef("");
    const handoffOwnershipRef = useRef<string | null>(null);
    const failedAttemptRef = useRef("");
    const nonceAtFailRef = useRef(0);
    const [handoffRetryNonce, setHandoffRetryNonce] = useState(0);
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const { lifetime, mountedRef, userScope } = useCanvasOwnerLifetime(projectId);
    useEffect(() => () => message.destroy(`canvas-handoff:${projectId}`), [message, projectId, userScope]);
    const linkedProjectQuery = useQuery({ queryKey: ["project", linkedProjectId], queryFn: () => getProject(linkedProjectId), enabled: Boolean(linkedProjectId) });
    const refetchLinkedProject = linkedProjectQuery.refetch;

    const archiveNodesToLinkedFolder = useCallback(
        (folder: CanvasNodeData, droppedNodes: CanvasNodeData[]) => {
            const folderId = folder.metadata?.folder?.assetFolderId;
            const domainProjectId = folder.metadata?.folder?.projectId || linkedProjectId;
            if (!folderId || !domainProjectId || !droppedNodes.length) return;
            const owner = lifetime.capture(projectId);
            const folderTitle = folder.title;
            void runOwnedCanvasPageCommit({
                owner,
                getLiveCanvasId: () => projectIdRef.current,
                getLiveLifetime: () => lifetime.current(),
                work: () => runOwnedCanvasEnsureQueue({
                    owner,
                    items: droppedNodes,
                    ensure: (node) => ensureCanvasNodeAsset({ canvasId: owner.canvasId, domainProjectId, folderId, node, source: "canvas-manual" }),
                }),
                onCommit: (results) => {
                    const archivedByNodeId = new Map(droppedNodes.flatMap((node, index) => {
                        const result = results[index];
                        if (!result?.confirmed) return [];
                        return [[node.id, { assetId: result.assetId, content: node.metadata?.content, previousAssetId: node.metadata?.assetId }] as const];
                    }));
                    setNodes((current) => applyArchivedCanvasNodeAssets(current, archivedByNodeId));
                    void refetchLinkedProject();
                    if (results.some((result) => !result?.confirmed)) {
                        message.warning("部分素材文件尚未保存到工作区，未完成归档，修改已保留在本机");
                    } else {
                        message.success(`已归档到“${folderTitle}”`);
                    }
                },
            }).catch((error) => {
                if (!lifetime.matches(owner, projectIdRef.current)) return;
                message.error(error instanceof Error ? error.message : "素材归档失败");
            });
        },
        [lifetime, linkedProjectId, message, projectId, refetchLinkedProject, setNodes],
    );

    useEffect(() => {
        if (!projectLoaded || !linkedProjectQuery.data) return;
        setNodes((current) => refreshCanvasCharacterReferenceNodes(current, linkedProjectQuery.data.assets));
    }, [linkedProjectQuery.data, projectLoaded, setNodes]);

    useEffect(() => {
        const project = linkedProjectQuery.data?.project;
        const preset = resolveProjectCanvasStyle(project?.stylePresetId, project?.styleProfileJson);
        if (!projectLoaded || !preset) return;
        const profile = resolveStyleProfile(project?.stylePresetId, project?.styleProfileJson, preset.profile || createStyleProfileSnapshot(preset));
        if (!profile) return;
        const current = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        const nextMetadata = {
            content: profile.prompt,
            prompt: profile.prompt,
            status: NODE_STATUS_SUCCESS,
            workflowKind: "styleboard" as const,
            workflowTitle: "项目画风",
            workflowDescription: profile.description,
            stylePresetId: profile.presetId,
            styleProfileJson: serializeStyleProfile(profile),
            fontSize: 14,
            locked: true,
        };
        if (current) {
            if (current.metadata?.stylePresetId === profile.presetId && current.metadata?.content === profile.prompt && current.metadata?.styleProfileJson === nextMetadata.styleProfileJson && current.metadata?.locked) return;
            setNodes((currentNodes) => currentNodes.map((node) => (node.id === current.id ? { ...node, title: `项目画风 · ${profile.title}`, metadata: { ...node.metadata, ...nextMetadata } } : node)));
            return;
        }
        const node = createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), nextMetadata);
        node.title = `项目画风 · ${profile.title}`;
        node.width = 420;
        node.height = 240;
        setNodes((currentNodes) => [...currentNodes, node]);
    }, [getCanvasCenter, linkedProjectQuery.data?.project, nodesRef, projectLoaded, setNodes]);

    useEffect(() => {
        const folders = linkedProjectQuery.data?.assetFolders;
        if (!folders?.length) return;
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const folderId = node.metadata?.folder?.assetFolderId;
                const folder = folderId ? byId.get(folderId) : undefined;
                if (!folder) return node;
                const { style, theme } = linkedFolderPresentation(folder);
                if (node.title === folder.name && node.metadata?.folder?.style === style && node.metadata?.folder?.theme === theme) return node;
                changed = true;
                return { ...node, title: folder.name, metadata: { ...node.metadata, folder: { ...node.metadata!.folder!, style, theme, themeCover: undefined } } };
            });
            return changed ? next : current;
        });
    }, [linkedProjectQuery.data?.assetFolders, setNodes]);

    useEffect(() => {
        if (!projectLoaded || searchParams.get("mode") !== "handoff") return;
        void loadAssetsForUse(canvasAssetHandoffIds(searchParams)).catch((error) => message.error(error instanceof Error ? error.message : "转入素材读取失败"));
    }, [projectLoaded, searchParams, message]);

    const requestHandoffRetry = useCallback(() => {
        if (assetHandoffRef.current) return;
        if (handoffOwnershipRef.current && handoffOwnershipRef.current !== userScope) return;
        message.destroy(`canvas-handoff:${projectId}`);
        failedAttemptRef.current = "";
        assetHandoffRef.current = "";
        setHandoffRetryNonce((nonce) => nonce + 1);
    }, [message, projectId, userScope]);

    const consumeForeignHandoff = useCallback((nextSearchParams: URLSearchParams) => {
        handoffOwnershipRef.current = null;
        assetHandoffRef.current = "";
        failedAttemptRef.current = "";
        setSearchParams(nextSearchParams, { replace: true });
    }, [setSearchParams]);

    useEffect(() => {
        const plan = resolveCanvasAssetHandoffPlan({
            projectLoaded,
            assetsHydrated,
            mode: searchParams.get("mode"),
            projectId,
            assets,
            searchParams,
            currentKey: assetHandoffRef.current,
            nodes: nodesRef.current,
        });
        const decision = planCanvasHandoffEffect({
            plan,
            searchParams,
            ownerUserScope: handoffOwnershipRef.current,
            liveUserScope: userScope,
            currentAttemptKey: assetHandoffRef.current,
            failedKey: failedAttemptRef.current,
            retryNonce: handoffRetryNonce,
            nonceAtFail: nonceAtFailRef.current,
        });
        if (decision.kind === "idle") return;
        if (decision.kind === "consume-foreign") {
            consumeForeignHandoff(decision.searchParams);
            return;
        }
        if (decision.kind === "blocked-until-retry") return;
        if (!handoffOwnershipRef.current) handoffOwnershipRef.current = userScope;
        assetHandoffRef.current = decision.key;
        if (decision.kind === "wait") return;
        const attemptKey = decision.key;
        const owner = lifetime.capture(projectId);
        const resetIfCurrentAttempt = () => {
            if (assetHandoffRef.current === attemptKey) assetHandoffRef.current = "";
        };
        void (async () => {
            try {
                const createdNodes = decision.payloads.length ? await createHandoffNodes(decision.payloads, getCanvasCenter()) : [];
                const result = await commitOwnedCanvasAssetHandoff({
                    owner,
                    getLiveCanvasId: () => projectIdRef.current,
                    getLiveLifetime: () => lifetime.current(),
                    stillOwnsPage: () => mountedRef.current && lifetime.matches(owner, projectIdRef.current),
                    attemptKey,
                    getAttemptKey: () => assetHandoffRef.current,
                    searchParams,
                    createdNodes,
                    readLiveNodes: () => readOwnedCanvasNodes({
                        owner,
                        liveCanvasId: projectIdRef.current,
                        liveLifetime: lifetime.current(),
                        pageNodes: nodesRef.current,
                        storedNodes: useCanvasStore.getState().openProject(owner.canvasId)?.nodes,
                    }),
                    persist: async (nextNodes) => {
                        await persistCanvasDocument(owner.canvasId, { nodes: nextNodes });
                    },
                    applyCreated: (created) => {
                        setNodes((current) => rebaseCreatedCanvasNodes(current, created));
                    },
                    consumeUrl: (nextSearchParams) => {
                        handoffOwnershipRef.current = null;
                        failedAttemptRef.current = "";
                        setSearchParams(nextSearchParams, { replace: true });
                    },
                    resetAttempt: resetIfCurrentAttempt,
                    onPersistError: () => {
                        if (assetHandoffRef.current !== attemptKey && assetHandoffRef.current !== "") return;
                        if (!lifetime.userMatches(owner)) {
                            consumeForeignHandoff(consumeCanvasAssetHandoff(searchParams));
                            return;
                        }
                        if (!mountedRef.current) return;
                        failedAttemptRef.current = attemptKey;
                        nonceAtFailRef.current = handoffRetryNonce;
                        message.error({
                            key: `canvas-handoff:${projectId}`,
                            content: createElement("span", null, CANVAS_HANDOFF_PERSIST_FAILED_MESSAGE, " ",
                                createElement(Button, { type: "link", size: "small", onClick: requestHandoffRetry }, "重试")),
                            duration: 0,
                        });
                    },
                });
                if (result === "abandoned" && !lifetime.userMatches(owner)) {
                    consumeForeignHandoff(consumeCanvasAssetHandoff(searchParams));
                    return;
                }
                if (result === "committed") {
                    handoffOwnershipRef.current = null;
                    failedAttemptRef.current = "";
                }
                if (result === "committed" && createdNodes.length && lifetime.matches(owner, projectIdRef.current)) {
                    message.success(`已引入 ${createdNodes.length} 项项目资产`);
                }
            } catch (error) {
                resetIfCurrentAttempt();
                if (!lifetime.userMatches(owner) || isUserScopeAbandonedError(error)) {
                    if (!lifetime.userMatches(owner)) consumeForeignHandoff(consumeCanvasAssetHandoff(searchParams));
                    return;
                }
                if (!mountedRef.current) return;
                message.error(error instanceof Error ? error.message : "项目资产引入失败");
            }
        })();
    }, [assets, assetsHydrated, consumeForeignHandoff, createHandoffNodes, getCanvasCenter, handoffRetryNonce, lifetime, message, mountedRef, nodesRef, projectId, projectLoaded, requestHandoffRetry, searchParams, setNodes, setSearchParams, userScope]);

    const reloadCanvasNodeResource = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.resourceReloadAvailable) return;
            const owner = lifetime.capture(projectId);
            const targetNodeId = node.id;
            // 继续取回登记为画布上的进行中请求：切换画布、同一节点上发起新请求时随之取消。
            const controller = startGenerationRequest(targetNodeId, targetNodeId, targetNodeId);
            const isCurrent = () => lifetime.matches(owner, projectIdRef.current) && !controller.signal.aborted;
            // 继续取回只等待并绑定原任务已生成的结果，不会重新提交生成。
            // 等待期间节点显示取回进度；失败后仍保留「继续取回」。
            setNodes((current) =>
                current.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, status: "loading", errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined } } : item)),
            );
            try {
                let task = await queryGenerationTask(taskId, { signal: controller.signal });
                if (!isCurrent()) return;
                if (task.status !== "succeeded") throw new Error("原生成任务尚未成功，暂时无法取回结果");
                if (task.stage === "delivery_paused" || task.stage === "delivery_timed_out") {
                    task = await retryGenerationTask(taskId);
                    if (!isCurrent()) return;
                }
                await applyGenerationTaskResult(targetNodeId, task, () => !controller.signal.aborted);
            } catch (error) {
                if (!isCurrent()) return;
                if (isUserScopeAbandonedError(error) || (error instanceof Error && error.name === "AbortError")) return;
                const failure = canvasGenerationFailureMetadata(error, { prompt: node.metadata?.prompt || "" });
                setNodes((current) =>
                    current.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, status: "error", ...failure, resourceReloadAvailable: failure.generationErrorCode !== "result_target_unavailable" } } : item)),
                );
                message.error(failure.errorDetails || "继续取回失败，请稍后重试");
            } finally {
                finishGenerationRequest(targetNodeId, controller);
            }
        },
        [applyGenerationTaskResult, finishGenerationRequest, lifetime, message, projectId, setNodes, startGenerationRequest],
    );

    return {
        linkedProjectQuery,
        refetchLinkedProject,
        archiveNodesToLinkedFolder,
        reloadCanvasNodeResource,
    };
}
