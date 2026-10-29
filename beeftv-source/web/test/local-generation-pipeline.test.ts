import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const configStore = readFileSync(new URL("../src/stores/use-config-store.ts", import.meta.url), "utf8");
const taskApi = readFileSync(new URL("../src/services/api/task-center.ts", import.meta.url), "utf8");
const taskSync = readFileSync(new URL("../src/lib/canvas/canvas-generation-task-sync.ts", import.meta.url), "utf8");
const fileStorage = readFileSync(new URL("../src/services/file-storage.ts", import.meta.url), "utf8");
const imageStorage = readFileSync(new URL("../src/services/image-storage.ts", import.meta.url), "utf8");
const channelSettings = readFileSync(new URL("../src/pages/settings/channel-settings-pane.tsx", import.meta.url), "utf8");

test("local generation pipeline keeps config, task lifecycle, and result storage scoped to the workspace", () => {
    expect(configStore).toContain("scopedLocalStorage");
    expect(configStore).toContain('name: CONFIG_STORE_KEY');
    expect(taskApi).toContain('http.post<GenerationTask>("/tasks"');
    expect(taskApi).toContain('http.get<GenerationTask[]>("/tasks"');
    expect(taskApi).toContain("waitForGenerationTask");
    expect(taskSync).toContain("buildGenerationTaskNodeResult");
    expect(taskSync).toContain("useCanvasStore.getState().updateProject");
    expect(fileStorage).toContain("pendingRemoteUpload");
    expect(fileStorage).toContain("await saveLocalMedia(storageKey, blob, previewUrl)");
    expect(imageStorage).toContain("pendingRemoteUpload");
    expect(imageStorage).toContain("await store.setItem(storageKey, blob)");
    expect(channelSettings).toContain("fetchChannelModels(channel, true, request.signal)");
    expect(channelSettings).toContain("mergeManagedBeefAPICatalog");
    expect(channelSettings).toContain("getLocalModelConfig");
    expect(channelSettings).toContain("shouldRefreshBeefAPICatalog");
});
