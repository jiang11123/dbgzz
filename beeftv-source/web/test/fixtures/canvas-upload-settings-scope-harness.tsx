import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";

import { createCanvasOwnerLifetime } from "../../src/pages/canvas/canvas-owner-epoch";
import { persistOwnedCanvasUploadNode } from "../../src/pages/canvas/canvas-upload-ownership";
import { shouldApplyProjectSettingsMutation } from "../../src/pages/projects/detail/project-settings-session";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { captureUserScope } from "../../src/lib/user-scope-guard";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

type HarnessWindow = Window & {
    __uploadSettingsHarness?: {
        writes: string[];
        toasts: string[];
        switchABA: () => Promise<void>;
        switchProject: () => void;
    };
};

const harnessWindow = window as HarnessWindow;

setActiveUserScope("owner-a");

function recordToast(node: Node) {
    const text = node.textContent?.trim();
    if (text) harnessWindow.__uploadSettingsHarness!.toasts.push(text);
}

function watchToasts() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.classList.contains("ant-message-notice") || node.querySelector?.(".ant-message-notice")) {
                    recordToast(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

async function switchABA() {
    await fetch("/harness/switch", { method: "POST" });
    setActiveUserScope("owner-b");
    setActiveUserScope("owner-a");
}

harnessWindow.__uploadSettingsHarness = { writes: [], toasts: [], switchABA, switchProject: () => {} };

function mediaNode(assetId?: string): CanvasNodeData {
    return {
        id: "media-1",
        type: CanvasNodeType.Image,
        title: "上传图片",
        position: { x: 0, y: 0 },
        width: 8,
        height: 8,
        metadata: { content: "data:image/png;base64,xx", assetId },
    };
}

function Harness() {
    const { message } = App.useApp();
    const lifetime = useMemo(() => createCanvasOwnerLifetime(), []);
    const canvasIdRef = useRef("canvas-a");
    const projectIdRef = useRef("project-a");
    const [projectId, setProjectId] = useState("project-a");
    const [persistState, setPersistState] = useState("idle");
    const [nodes, setNodes] = useState<CanvasNodeData[]>([mediaNode()]);
    const [settingsState, setSettingsState] = useState("idle");

    harnessWindow.__uploadSettingsHarness!.switchProject = () => {
        projectIdRef.current = "project-b";
        setProjectId("project-b");
        setSettingsState("idle");
    };

    const persistUpload = async () => {
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a");
        setPersistState("pending");
        const result = await persistOwnedCanvasUploadNode({
            owner,
            expectedScope,
            getLiveCanvasId: () => canvasIdRef.current,
            getLiveLifetime: () => lifetime.current(),
            canvasId: "canvas-a",
            domainProjectId: "project-a",
            node: mediaNode(),
        }, {
            ensureCanvasNodeAsset: async () => {
                const response = await fetch("/api/harness/ensure", { method: "POST" });
                const body = await response.json() as { confirmed?: boolean; error?: string };
                if (body.error) throw new Error(body.error);
                return { assetId: "asset-1", created: true, linkedToProject: Boolean(body.confirmed), confirmed: Boolean(body.confirmed) };
            },
            setNodes: (updater) => {
                harnessWindow.__uploadSettingsHarness!.writes.push("setNodes");
                setNodes((current) => updater(current));
            },
            invalidateProject: async () => {
                harnessWindow.__uploadSettingsHarness!.writes.push("invalidate");
            },
            warn: (text) => message.warning(text),
        });
        if (result.confirmed) {
            setPersistState("saved");
            message.success("文件已添加到画布");
            return;
        }
        if (result.applied) {
            setPersistState("draft");
            return;
        }
        setPersistState("idle");
    };

    const saveSettings = async () => {
        const entryScope = captureUserScope();
        const mountedProjectId = projectIdRef.current;
        setSettingsState("pending");
        try {
            const response = await fetch("/api/harness/save", { method: "POST" });
            const body = await response.json() as { ok?: boolean; error?: string };
            if (body.error) throw new Error(body.error);
            if (!shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId,
                liveProjectId: projectIdRef.current,
                mounted: true,
            })) {
                setSettingsState("idle");
                return;
            }
            harnessWindow.__uploadSettingsHarness!.writes.push(`save:${mountedProjectId}`);
            setSettingsState("saved");
            message.success("项目设置已保存");
        } catch (error) {
            if (!shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId,
                liveProjectId: projectIdRef.current,
                mounted: true,
                error,
            })) {
                setSettingsState("idle");
                return;
            }
            setSettingsState("error");
            message.error(error instanceof Error ? error.message : "项目设置保存失败");
        }
    };

    return (
        <>
            <div style={{ position: "fixed", top: 0, left: 0, zIndex: 11000, display: "flex", gap: 8, padding: 8 }}>
                <button type="button" onClick={() => void switchABA()}>switch-aba</button>
                <button type="button" onClick={() => harnessWindow.__uploadSettingsHarness!.switchProject()}>switch-project</button>
                <button type="button" onClick={() => void persistUpload()}>persist-upload</button>
                <button type="button" onClick={() => void saveSettings()}>save-settings</button>
            </div>
            <main style={{ padding: 48 }}>
                <p data-testid="persist-state">{persistState}</p>
                <p data-testid="node-asset">{String(nodes[0]?.metadata?.assetId || "")}</p>
                <p data-testid="settings-state">{settingsState}</p>
                <p data-testid="project-id">{projectId}</p>
            </main>
        </>
    );
}

watchToasts();
createRoot(document.getElementById("root")!).render(<App><Harness /></App>);
