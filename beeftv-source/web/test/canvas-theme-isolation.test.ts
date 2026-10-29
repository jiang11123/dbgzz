import { afterEach, describe, expect, test } from "bun:test";
import { normalizeTheme, useThemeStore } from "../src/stores/use-theme-store";
import { useCanvasThemeStore } from "../src/stores/canvas/use-canvas-theme-store";

const workspaceBefore = useThemeStore.getState().theme;
const canvasBefore = useCanvasThemeStore.getState().theme;
const followBefore = useCanvasThemeStore.getState().followGlobal;
afterEach(() => {
    useThemeStore.setState({ theme: workspaceBefore });
    useCanvasThemeStore.setState({ theme: canvasBefore, followGlobal: followBefore, active: false });
});

describe("canvas theme ownership", () => {
    test("editing the canvas theme never mutates the workspace preference", () => {
        useThemeStore.setState({ theme: "light" });
        useCanvasThemeStore.setState({ active: true });
        useCanvasThemeStore.getState().setTheme("dark");
        expect(useThemeStore.getState().theme).toBe("light");
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
        useCanvasThemeStore.setState({ active: false });
        expect(useThemeStore.getState().theme).toBe("light");
    });
    test("workspace switches cannot change canvas preference", () => {
        useCanvasThemeStore.getState().setAppearance({ mode: "light" });
        useThemeStore.getState().setTheme("dark");
        expect(useCanvasThemeStore.getState().theme).toBe("light");
    });
    test("accepts explicit light while rejecting invalid persisted or requested values", () => {
        useCanvasThemeStore.getState().setTheme("light");
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        useThemeStore.getState().setTheme("light");
        expect(useThemeStore.getState().theme).toBe("light");
        expect(normalizeTheme("light")).toBe("light");
        expect(normalizeTheme("bogus")).toBe("dark");
        useCanvasThemeStore.setState({ theme: "light", active: true });
        useCanvasThemeStore.getState().setTheme("invalid" as "light");
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
    });
    test("following canvases react to global changes without replacing the saved mode", () => {
        useThemeStore.setState({ theme: "dark" });
        useCanvasThemeStore.getState().setAppearance({ mode: "follow" });
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
        useThemeStore.setState({ theme: "light" });
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        expect(useCanvasThemeStore.getState().followGlobal).toBe(true);
        useThemeStore.setState({ theme: "dark" });
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
    });
    test("reopening a following canvas does not inherit the previous canvas override", () => {
        useThemeStore.setState({ theme: "dark" });
        useCanvasThemeStore.getState().setAppearance({ mode: "light" });
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        useCanvasThemeStore.getState().setAppearance({ mode: "follow" });
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
    });
    test("custom white backgrounds can keep a light interface while global mode changes", () => {
        useCanvasThemeStore.getState().setAppearance({ mode: "custom", custom: { baseTheme: "light", backgroundColor: "#FFFFFF", backgroundBrightness: 0, gridColor: "#000000", gridOpacity: 50 } });
        useThemeStore.setState({ theme: "light" });
        useThemeStore.setState({ theme: "dark" });
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        expect(useCanvasThemeStore.getState().followGlobal).toBe(false);
    });
});
