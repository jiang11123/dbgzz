import { describe, expect, test } from "bun:test";

import { useDirectorWorkbenchStore } from "../src/stores/canvas/use-director-workbench-store";

describe("导演台时间轴显示状态", () => {
    test("新会话打开时间线时采用参考页约 130px 的紧凑高度，也可展开到高级轨道", () => {
        const store = useDirectorWorkbenchStore;
        store.getState().reset();
        expect(store.getState().sequencerHeight).toBe(130);
        store.getState().setSequencerHeight(300);
        expect(store.getState().sequencerHeight).toBe(300);
        store.getState().setSequencerHeight(130);
        expect(store.getState().sequencerHeight).toBe(130);
    });
    test("新会话默认摆场且时间轴收起；摆场模式也可独立展开与收起", () => {
        const store = useDirectorWorkbenchStore;
        store.getState().reset();
        expect(store.getState().mode).toBe("layout");
        expect(store.getState().sequencerVisible).toBe(false);
        store.getState().setMode("layout");
        store.getState().setSequencerVisible(true);
        expect(store.getState().sequencerVisible).toBe(true);
        expect(store.getState().mode).toBe("layout");
        store.getState().setSequencerVisible(false);
        expect(store.getState().sequencerVisible).toBe(false);
    });

    test("顶部动画模式仍自动打开时间轴，切回摆场后由底部按钮控制收起", () => {
        const store = useDirectorWorkbenchStore;
        store.getState().reset();
        store.getState().setMode("animate");
        expect(store.getState().sequencerVisible).toBe(true);
        store.getState().setMode("layout");
        expect(store.getState().sequencerVisible).toBe(true);
        store.getState().setSequencerVisible(false);
        expect(store.getState().sequencerVisible).toBe(false);
        store.getState().reset();
    });
});
