import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Use the explicit Node renderer so Bun cannot select the browser server
// build when another parallel test has installed partial DOM globals.
import { renderToStaticMarkup } from "react-dom/server.node";

import { CanvasModeMenu, createCanvasModeDockCommand } from "@/components/canvas/canvas-toolbar";

describe("LibTV canvas navigation dock", () => {
    test("keeps the centered creation rail on the same compact scale as the left view rail", () => {
        const root = resolve(import.meta.dir, "..");
        const dock = readFileSync(resolve(root, "src/components/ui/aceternity/floating-dock.tsx"), "utf8");
        const styles = readFileSync(resolve(root, "src/styles/globals.css"), "utf8");

        expect(dock).toContain("libtv: { base: 32, magnified: 32, icon: 18, iconMagnified: 18, distance: 0 }");
        expect(styles).toContain("height: 44px !important;");
        expect(styles).toContain("padding: 4px !important;");
    });

    test("uses a black plus glyph on the white prominent add button", () => {
        const styles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");

        expect(styles).toContain(".libtv-main-dock .aceternity-dock-command.is-prominent > span:first-child svg");
        expect(styles).toContain("stroke: rgb(17 17 17) !important;");
    });

    test("sizes the LibTV main rail to its controls instead of reserving a blank tail", () => {
        const toolbar = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-toolbar.tsx"), "utf8");
        const styles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");

        expect(toolbar).not.toContain("sm:min-w-[338px]");
        expect(styles).not.toContain(".canvas-libtv-compat-toolbar .libtv-main-dock {\n        height: 44px !important;\n        min-width: 300px !important;");
    });

    test("renders one current-tool trigger instead of the split black/white switch", () => {
        const command = createCanvasModeDockCommand("move", true, () => {});

        expect(command.kind).toBe("command");
        expect(command.id).toBe("tool-canvas-mode-trigger");
        expect(command.label).toBe("抓手工具");
        expect(command.active).toBe(true);
        expect(command.expands).toBe(true);
    });

    test("renders the LibTV move/grab menu with active state and shortcuts", () => {
        const html = renderToStaticMarkup(
            <CanvasModeMenu canvasTool="move" x={120} onSelect={() => {}} />,
        );

        expect(html).toContain('role="menu"');
        expect(html).toContain("移动");
        expect(html).toContain("抓手工具");
        expect(html).toContain(">V<");
        expect(html).toContain(">H<");
        expect(html).toContain('aria-checked="true"');
        expect(html).toContain("canvas-mode-menu");
    });
});
