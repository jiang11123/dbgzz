import { expect, test } from "bun:test";

const projectSource = await Bun.file(new URL("../src/pages/canvas/project.tsx", import.meta.url)).text();
const promptEditorSource = await Bun.file(new URL("../src/components/canvas/canvas-resource-mention-textarea.tsx", import.meta.url)).text();

test("canvas node context menu preserves the native menu for editable text targets", () => {
    const handlerStart = projectSource.indexOf("const handleNodeContextMenu = useCallback(");
    const handler = projectSource.slice(handlerStart, projectSource.indexOf("\n    );", handlerStart) + 7);

    expect(handler).toContain("isCanvasTextEditingTarget(event.target)");
    expect(handler.indexOf("isCanvasTextEditingTarget(event.target)")).toBeLessThan(handler.indexOf("event.preventDefault()"));
});

test("plain and rich prompt editors stop context-menu bubbling without cancelling the native menu", () => {
    expect(promptEditorSource.split("onContextMenu={preserveNativeTextContextMenu}").length - 1).toBe(2);
    const handlerStart = promptEditorSource.indexOf("const preserveNativeTextContextMenu");
    const handler = promptEditorSource.slice(handlerStart, promptEditorSource.indexOf("\n    };", handlerStart) + 7);
    expect(handler).toContain("event.stopPropagation()");
    expect(handler).not.toContain("event.preventDefault()");
});
