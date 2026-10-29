import { createRoot } from "react-dom/client";
import { App } from "antd";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CanvasPage from "../../src/pages/canvas";
import { useCanvasStore, type CanvasProject } from "../../src/stores/canvas/use-canvas-store";
import { useUserStore } from "../../src/stores/use-user-store";
import { exportCanvasProjects } from "../../src/lib/canvas/canvas-export";
import { setMediaBlob, getMediaBlob } from "../../src/services/file-storage";
import { reportOwnedMediaSave } from "../../src/services/desktop-media-save";
import { configureApiRuntime } from "../../src/services/api/request";
import { CANVAS_FOLDER_PENDING_STORE_NAME, localForageInstance, localForageStorageForScope } from "../../src/lib/localforage-storage";

let archive = "";
if (window.location.search.includes("new=1")) configureApiRuntime(`${window.location.origin}/api`, "");
Object.assign(window, { go: { main: { DesktopApp: { SaveOwnedArtifact: async (_name: string, data: string) => { archive = data; return true; } } } } });

function fixtureProject(id: string): CanvasProject {
    return {
        id, title: `测试 ${id}`, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
        nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 }, directorScenes: [],
        timeline: { version: 2, durationMs: 1000, tracks: [{ id: "voice", kind: "audio", label: "配音", order: 0 }], clips: [
            { id: "voice", kind: "audio", nodeId: "direct:voice", trackId: "voice", startMs: 0, durationMs: 1000,
                directMedia: { id: "voice", kind: "audio", title: "测试配音", storageKey: "audio:fixture:voice", url: "blob:expired", mimeType: "audio/wav", durationMs: 1000 } },
        ] },
    };
}

function Controls() {
    const { message } = App.useApp();
    return <button onClick={() => void reportOwnedMediaSave(message, exportCanvasProjects([fixtureProject("missing")]))}>测试缺失导出</button>;
}

function RouteReceipt() {
    const location = useLocation();
    return <output data-testid="canvas-route">{location.pathname}{location.search}</output>;
}

Object.assign(window, { exportFixture: {
    seedBlockingExport() {
        const project = fixtureProject("blocked-export");
        project.timeline!.clips[0]!.directMedia!.storageKey = "resource:blocked-export";
        useCanvasStore.setState({ projects: [project] });
        return project;
    },
    async export() {
        await setMediaBlob("audio:fixture:voice", new Blob(["unique archive bytes"], { type: "audio/wav" }));
        await exportCanvasProjects([fixtureProject("first"), fixtureProject("second")]);
        return archive;
    },
    async exportEmpty() {
        archive = "";
        await exportCanvasProjects([]);
        return archive;
    },
    async snapshot() {
        const restoredKey = useCanvasStore.getState().projects[0]?.timeline?.clips[0]?.directMedia?.storageKey;
        const media = await getMediaBlob(restoredKey || "audio:fixture:voice");
        return { projects: useCanvasStore.getState().projects, media: media ? await media.text() : null, archive };
    },
    async probeSharedStores() {
        const app = localForageStorageForScope("guest");
        const folder = localForageInstance(CANVAS_FOLDER_PENDING_STORE_NAME);
        try {
            await Promise.all([
                app.getItem("canvas-document-journal:startup-probe"),
                folder.getItem("guest"),
            ]);
            await app.setItem("canvas-document-journal:startup-probe", "{\"ok\":true}");
            await folder.setItem("guest", { version: 1, intents: {}, highWater: {} });
            return {
                journal: await app.getItem("canvas-document-journal:startup-probe"),
                pending: await folder.getItem("guest"),
            };
        } catch (error) {
            return { error: error instanceof Error ? `${error.name}:${error.message}` : String(error) };
        }
    },
} });

await useCanvasStore.persist.rehydrate();
useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
useCanvasStore.setState({ hydrated: true });
createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[window.location.search.includes("new=1") ? "/canvas?mode=new" : "/canvas"]}><App><Controls /><RouteReceipt /><CanvasPage /></App></MemoryRouter>
    </QueryClientProvider>,
);
