import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-level assertions: rendering the full lifecycle hook needs a browser
// (see canvas-lifecycle-restart.browser.test.ts). These lock the wiring.
const lifecycle = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-project-lifecycle.ts"), "utf8");

function leaveFlushEffect() {
    const start = lifecycle.indexOf("const flushOnLeave = (reason: string) => {");
    expect(start).toBeGreaterThan(-1);
    const effectStart = lifecycle.lastIndexOf("useEffect(() => {", start);
    const end = lifecycle.indexOf("}, [connectionsRef, localMode, nodesRef, projectId, projectLoaded, updateProject, viewportRef]);", start);
    expect(end).toBeGreaterThan(start);
    return lifecycle.slice(effectStart, end);
}

describe("canvas editor flushes content when leaving", () => {
    test("flushes on unmount, pagehide and visibilitychange to hidden", () => {
        const effect = leaveFlushEffect();
        expect(effect).toContain('window.addEventListener("pagehide", handlePageHide);');
        expect(effect).toContain('document.addEventListener("visibilitychange", handleVisibilityChange);');
        expect(effect).toContain('if (document.visibilityState === "hidden") flushOnLeave("hidden");');
        expect(effect).toMatch(/return \(\) => \{\s*window\.removeEventListener\("pagehide", handlePageHide\);\s*document\.removeEventListener\("visibilitychange", handleVisibilityChange\);\s*flushOnLeave\("leave"\);\s*\};/);
    });

    test("writes live nodes and connections when they differ from the observed baseline", () => {
        const effect = leaveFlushEffect();
        expect(effect).toContain("if (editorProjectIdRef.current !== projectId) return;");
        expect(effect).toContain("const snapshot = { nodes: nodesRef.current, connections: connectionsRef.current, ...live };");
        expect(effect).toContain("JSON.stringify(observedContentRef.current) !== JSON.stringify(snapshot)");
        // Store changes the editor has not seen yet are carried into the write, not overwritten.
        expect(effect).toContain("const { next } = reconcileEditorSnapshot(snapshot);");
        expect(effect).toContain("nodes: next.nodes,");
        expect(effect).toContain("connections: next.connections,");
        expect(effect).toContain("observedContentRef.current = next;");
    });

    test("flushes the store write queue and then the local backend without waiting for timers", () => {
        const effect = leaveFlushEffect();
        expect(effect).toMatch(/await flushCanvasStorePersistence\(\);\s*if \(!userScopeMatches\(owner\)\) return;\s*if \(localMode\) await syncLocalCanvasProjectToBackend\(projectId, owner\);/);
        expect(effect).toContain('console.error("离开画布时保存失败"');
    });

    test("non-ref editor state is captured in a layout effect, not during render", () => {
        expect(lifecycle).toMatch(/useLayoutEffect\(\(\) => \{\s*leaveFlushStateRef\.current = \{ chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo \};/);
    });
});
