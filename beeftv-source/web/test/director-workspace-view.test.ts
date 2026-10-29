import { afterEach, describe, expect, test } from "bun:test";

import { useDirectorWorkbenchStore } from "../src/stores/canvas/use-director-workbench-store";

describe("导演台工作区视图", () => {
    afterEach(() => useDirectorWorkbenchStore.getState().reset());

    test("成片预演使用当前镜头并显示时间线，返回场景调度时恢复原视图状态", () => {
        const store = useDirectorWorkbenchStore;
        store.getState().setMode("camera");
        store.getState().setRenderMode("depth");
        store.getState().setViewMode("top");
        store.getState().setSequencerVisible(false);

        store.getState().setWorkspaceView("preview");
        expect(store.getState().workspaceView).toBe("preview");
        expect(store.getState().viewMode).toBe("camera");
        expect(store.getState().sequencerVisible).toBe(true);
        expect(store.getState().renderMode).toBe("beauty");

        store.getState().setWorkspaceView("scene");
        expect(store.getState().workspaceView).toBe("scene");
        expect(store.getState().viewMode).toBe("top");
        expect(store.getState().sequencerVisible).toBe(false);
        expect(store.getState().renderMode).toBe("depth");
    });

    test("从场景调度切入预演不会改动持久化场景或历史状态字段", () => {
        const before = useDirectorWorkbenchStore.getState();
        before.setWorkspaceView("preview");
        const after = useDirectorWorkbenchStore.getState();

        expect(after.mode).toBe(before.mode);
        expect(after.selectedObjectId).toBe(before.selectedObjectId);
        expect(after.renderMode).toBe(before.renderMode);
    });
});
