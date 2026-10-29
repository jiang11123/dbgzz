import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
    DEFAULT_CANVAS_BACKGROUND_MODE,
    canvasAppearanceForTheme,
    customCanvasAppearanceFromTheme,
    enterCustomCanvasAppearance,
    normalizeCanvasAppearance,
    normalizeHexColor,
    readCanvasAppearanceDefault,
    resolveCanvasAppearance,
    resolveCanvasGridColor,
    writeCanvasAppearanceDefault,
} from "../src/lib/canvas/canvas-appearance";
import { setActiveUserScope } from "../src/lib/user-scope";

const values = new Map<string, string>();
let originalWindow: PropertyDescriptor | undefined;

beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    values.clear();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            localStorage: {
                getItem: (key: string) => values.get(key) || null,
                setItem: (key: string, value: string) => values.set(key, value),
                removeItem: (key: string) => values.delete(key),
            },
        },
    });
});

afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

describe("canvas custom appearance", () => {
    test("missing or invalid appearance follows the current global theme", () => {
        expect(normalizeCanvasAppearance(undefined, "light")).toEqual({ mode: "follow" });
        expect(normalizeCanvasAppearance({ mode: "invalid" }, "dark")).toEqual({ mode: "follow" });
        expect(resolveCanvasAppearance({ mode: "follow" }, "light").background).toBe("#f0f0f0");
        expect(resolveCanvasAppearance({ mode: "follow" }, "dark").background).toBe("#141414");
    });
    test("following ignores remembered custom substrate but preserves it for later edits", () => {
        const custom = customCanvasAppearanceFromTheme("light").custom;
        const following = { mode: "follow" as const, custom };
        expect(resolveCanvasAppearance(following, "dark").baseTheme).toBe("dark");
        expect(enterCustomCanvasAppearance(following, "dark").custom).toEqual(custom);
        writeCanvasAppearanceDefault({ appearance: following, backgroundMode: "dots" });
        expect(readCanvasAppearanceDefault()?.appearance.mode).toBe("follow");
    });
    test("uses point grid as the default for new canvases", () => {
        expect(DEFAULT_CANVAS_BACKGROUND_MODE).toBe("dots");
    });

    test("inherits the selected light or dark substrate in custom mode", () => {
        const light = enterCustomCanvasAppearance(canvasAppearanceForTheme("light"), "light");
        expect(light).toEqual({
            mode: "custom",
            custom: {
                baseTheme: "light",
                backgroundColor: "#F0F0F0",
                backgroundBrightness: 0,
                gridColor: "#000000",
                gridOpacity: 80,
            },
        });

        const dark = enterCustomCanvasAppearance(canvasAppearanceForTheme("dark"), "dark");
        expect(dark.custom).toMatchObject({ baseTheme: "dark", backgroundColor: "#141414", backgroundBrightness: 0, gridColor: "#AFAFAF", gridOpacity: 80 });
    });

    test("preserves custom colors and their substrate when trying fixed themes", () => {
        const previous = customCanvasAppearanceFromTheme("light");
        previous.custom = { ...previous.custom!, backgroundColor: "#F3DCE5" };
        const fixedLight = canvasAppearanceForTheme("light", previous);
        expect(enterCustomCanvasAppearance(fixedLight, "light").custom).toEqual(previous.custom);

        const fixedDark = canvasAppearanceForTheme("dark", previous);
        expect(fixedDark.custom).toEqual(previous.custom);
        expect(enterCustomCanvasAppearance(fixedDark, "dark").custom).toMatchObject({
            baseTheme: "light",
            backgroundColor: "#F3DCE5",
        });
    });

    test("keeps color-picker popups inside the appearance interaction boundary", async () => {
        const toolbarSource = await Bun.file(new URL("../src/components/canvas/canvas-toolbar.tsx", import.meta.url)).text();
        const controlsSource = await Bun.file(new URL("../src/components/canvas/canvas-appearance-controls.tsx", import.meta.url)).text();
        expect(toolbarSource).toContain('closest(".ant-color-picker,.ant-popover")');
        expect(controlsSource).toContain("if (normalized) onChange(normalized)");
    });

    test("commits custom colors immediately instead of discarding them when the panel closes", async () => {
        const controlsSource = await Bun.file(new URL("../src/components/canvas/canvas-appearance-controls.tsx", import.meta.url)).text();
        const updateCustomSource = controlsSource.slice(
            controlsSource.indexOf("const updateCustom"),
            controlsSource.indexOf("const resetCustom"),
        );
        expect(updateCustomSource).toContain("onAppearanceChange(next)");
        expect(updateCustomSource).not.toContain("onAppearancePreviewChange(next)");
    });

    test("keeps hex editing live across parent updates and common hex formats", async () => {
        expect(normalizeHexColor("F3DCE5")).toBe("#F3DCE5");
        expect(normalizeHexColor("#f3d")).toBe("#FF33DD");

        const controlsSource = await Bun.file(new URL("../src/components/canvas/canvas-appearance-controls.tsx", import.meta.url)).text();
        expect(controlsSource).toContain("if (!editing) setTextValue(value)");
        expect(controlsSource).toContain("updateCustom({ backgroundColor, backgroundBrightness: 0 })");
    });

    test("adjusts only the custom canvas substrate and grid", () => {
        const appearance = normalizeCanvasAppearance({
            mode: "custom",
            custom: {
                baseTheme: "light",
                backgroundColor: "#F3DCE5",
                backgroundBrightness: 0,
                backgroundOpacity: 10,
                gridColor: "#9D7182",
                gridOpacity: 22,
            },
        }, "dark");

        const resolved = resolveCanvasAppearance(appearance, "dark");
        expect(resolved.baseTheme).toBe("light");
        expect(resolved.background).toBe("#F3DCE5");
        expect(resolveCanvasGridColor(appearance, "dark", "lines")).toBe("rgba(157,113,130,0.22)");

        appearance.custom!.backgroundBrightness = 10;
        const brighter = resolveCanvasAppearance(appearance, "dark").background;
        appearance.custom!.backgroundBrightness = -10;
        const darker = resolveCanvasAppearance(appearance, "dark").background;

        const brighterParts = brighter.match(/^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/);
        const darkerParts = darker.match(/^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/);
        expect(brighterParts).not.toBeNull();
        expect(darkerParts).not.toBeNull();
        expect(Number(brighterParts![1])).toBeGreaterThan(Number(darkerParts![1]));
        expect(brighterParts!.slice(2)).toEqual(darkerParts!.slice(2));
    });

    test("keeps the interface dark without changing custom canvas colors", () => {
        const appearance = customCanvasAppearanceFromTheme("dark");
        appearance.custom = {
            ...appearance.custom!,
            baseTheme: "dark",
            backgroundColor: "#F3DCE5",
            gridColor: "#9D7182",
            gridOpacity: 22,
        };

        expect(resolveCanvasAppearance(appearance, "dark")).toEqual({
            baseTheme: "dark",
            background: "#F3DCE5",
            grid: "rgba(157,113,130,0.22)",
        });
    });

    test("does not expose background opacity after legacy values are ignored", async () => {
        const controlsSource = await Bun.file(new URL("../src/components/canvas/canvas-appearance-controls.tsx", import.meta.url)).text();
        expect(controlsSource).toContain('const DARK_PRESETS = ["#000000"');
        expect(controlsSource).not.toContain('label="背景透明度"');
        expect(controlsSource).toContain("深色界面");
        expect(controlsSource).toContain('label="网格强度"');
    });

    test("stores defaults locally with the active account scope", () => {
        setActiveUserScope("account-A");
        const value = { appearance: customCanvasAppearanceFromTheme("dark"), backgroundMode: "lines" as const };
        writeCanvasAppearanceDefault(value);

        expect(values.has("infinite-canvas:canvas-appearance-default:v2:user:account-A")).toBe(true);
        expect(readCanvasAppearanceDefault()).toEqual(value);

        setActiveUserScope("account-B");
        expect(readCanvasAppearanceDefault()).toBeNull();
    });
});
