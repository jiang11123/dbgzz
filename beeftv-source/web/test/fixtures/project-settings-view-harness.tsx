import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";

import { setActiveUserScope } from "../../src/lib/user-scope";
import type { Project, ProjectDetail } from "../../src/services/api/projects";
import { useUserStore } from "../../src/stores/use-user-store";
import ProjectSettingsView from "../../src/pages/projects/detail/settings";

type HarnessWindow = Window & {
    __projectSettingsHarness?: {
        toasts: string[];
        refreshCount: number;
        strictSetups: number;
        strictCleanups: number;
        switchABA: () => Promise<void>;
        switchProjectABA: () => void;
    };
};

const harnessWindow = window as HarnessWindow;

useUserStore.setState({
    hydrated: true,
    storageMode: "remote",
    user: {
        id: "owner-a",
        username: "remote-user",
        displayName: "账号 A",
        role: "user",
        status: "active",
    },
});
setActiveUserScope("owner-a");

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
    },
});

function makeProject(id: string, status: Project["status"]): Project {
    return {
        id,
        userId: "owner-a",
        name: id === "project-a" ? "项目甲" : "项目乙",
        type: "short-drama",
        aspectRatio: "9:16",
        sourceType: "blank",
        description: "",
        stylePresetId: "",
        status,
        revision: 1,
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function makeDetail(id: string, status: Project["status"] = "active"): ProjectDetail {
    return {
        project: makeProject(id, status),
        units: [],
        canvases: [],
        canvasUnitLinks: [],
        assets: [],
        assetFolders: [],
        workflows: [],
        shots: [],
        shotRevisions: [],
        shotArtifacts: [],
        shotReferences: [],
        assetCandidates: [],
        tasks: [],
    };
}

function recordToast(node: Node) {
    const text = node.textContent?.trim();
    if (text) harnessWindow.__projectSettingsHarness!.toasts.push(text);
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

harnessWindow.__projectSettingsHarness = {
    toasts: [],
    refreshCount: 0,
    strictSetups: 0,
    strictCleanups: 0,
    switchABA,
    switchProjectABA: () => {},
};

function Harness() {
    const [detail, setDetail] = useState(() => makeDetail("project-a"));
    const projectIdRef = useRef(detail.project.id);
    projectIdRef.current = detail.project.id;

    useEffect(() => {
        harnessWindow.__projectSettingsHarness!.strictSetups += 1;
        return () => {
            harnessWindow.__projectSettingsHarness!.strictCleanups += 1;
        };
    }, []);

    harnessWindow.__projectSettingsHarness!.switchProjectABA = () => {
        flushSync(() => {
            setDetail(makeDetail("project-b"));
        });
        flushSync(() => {
            setDetail(makeDetail("project-a"));
        });
    };

    const refreshProject = () => {
        harnessWindow.__projectSettingsHarness!.refreshCount += 1;
        const projectId = projectIdRef.current;
        void fetch(`/api/projects/${encodeURIComponent(projectId)}`)
            .then((response) => response.json())
            .then((envelope: { data?: { project?: Project } | Project }) => {
                const payload = envelope.data;
                const project = payload && typeof payload === "object" && "project" in payload
                    ? payload.project
                    : payload as Project | undefined;
                if (!project?.id) return;
                setDetail((current) => current.project.id === project.id ? { ...current, project: { ...current.project, ...project } } : current);
            });
    };

    return (
        <div>
            <div data-testid="project-id">{detail.project.id}</div>
            <div data-testid="project-status">{detail.project.status}</div>
            <div data-testid="refresh-count">{harnessWindow.__projectSettingsHarness!.refreshCount}</div>
            <ProjectSettingsView detail={detail} refreshProject={refreshProject} onCreateCanvas={() => {}} />
        </div>
    );
}

watchToasts();
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <App>
                <Harness />
            </App>
        </QueryClientProvider>
    </StrictMode>,
);
