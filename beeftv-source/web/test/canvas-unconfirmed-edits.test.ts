import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { canvasUnconfirmedDiagnostic, canvasUnconfirmedReason, type CanvasUnconfirmedState } from "@/lib/canvas/canvas-unconfirmed-edits";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const base = { id: "c", title: "private title", nodes: [{ id: "NODE-ID-MUST-NOT-LEAK", type: "image", metadata: { content: "private resource", storageKey: "resource:private" } }], connections: [], chatSessions: [], activeChatId: null } as unknown as CanvasProject;
const clean: CanvasUnconfirmedState = { live: base, confirmed: base, pending: false, blocked: false, inFlight: false, pendingProjection: false };

test("dirty classification preserves every blocking state and confirmed baseline precedence", () => {
    expect(canvasUnconfirmedReason(clean)).toBeUndefined();
    for (const reason of ["pending", "blocked", "inFlight", "pendingProjection"] as const) {
        expect(canvasUnconfirmedReason({ ...clean, [reason]: true })).toBe(reason);
        expect(canvasUnconfirmedReason({ ...clean, live: undefined, [reason]: true })).toBeUndefined();
    }
    const changed = { ...base, title: "new private title" };
    expect(canvasUnconfirmedReason({ ...clean, live: changed })).toBe("confirmed-diff");
    expect(canvasUnconfirmedReason({ ...clean, live: changed, confirmed: undefined, durable: base })).toBe("durable-diff");
    expect(canvasUnconfirmedReason({ ...clean, confirmed: undefined })).toBe("no-baseline");
    expect(canvasUnconfirmedReason({ ...clean, durable: changed })).toBeUndefined();
});

test("diagnostics report fixed field names without values or unknown metadata keys", () => {
    const live = structuredClone(base);
    live.title = "SECRET-TITLE";
    live.nodes[0].metadata = { ...live.nodes[0].metadata, prompt: "SECRET-PROMPT", content: "https://secret.test/file", naturalWidth: 1254, privateToken: "TOKEN-MUST-NOT-LEAK", "secret-dynamic-field": "VALUE-MUST-NOT-LEAK" } as never;
    (live as unknown as Record<string, unknown>)["secret-root-field"] = "SECRET-ROOT-VALUE";
    const result = canvasUnconfirmedDiagnostic({ ...clean, live });
    expect(result).toEqual({ reason: "confirmed-diff", fields: ["title", "nodes"], nodeFields: [], metadataFields: ["prompt", "content", "naturalWidth"] });
    const text = JSON.stringify(result);
    for (const forbidden of ["SECRET", "secret", "privateToken", "private resource", "resource:private", "1254", "NODE-ID-MUST-NOT-LEAK", "https", "TOKEN", "VALUE"]) expect(text).not.toContain(forbidden);
});

test("unknown document edits still block, while diagnostics omit their dynamic names", () => {
    const live = { ...base, unknownField: "private" } as CanvasProject;
    expect(canvasUnconfirmedReason({ ...clean, live })).toBe("confirmed-diff");
    expect(canvasUnconfirmedDiagnostic({ ...clean, live })).toEqual({ reason: "confirmed-diff", fields: [], nodeFields: [], metadataFields: [] });
    expect(canvasUnconfirmedReason({ ...clean, live: { ...base, viewport: { x: 5, y: 6, k: 1 } } })).toBeUndefined();
});


test("fixed node and media metadata names identify runtime changes without exposing values", () => {
    const live = structuredClone(base);
    Object.assign(live.nodes[0], { updatedAt: "SECRET-TIME", position: { x: 899, y: 734 }, title: "SECRET-NODE-TITLE" });
    Object.assign(live.nodes[0].metadata!, { videoPreview: "SECRET-URL", hasAudio: true, generateAudio: true, watermark: true });
    const result = canvasUnconfirmedDiagnostic({ ...clean, live });
    expect(result?.nodeFields).toEqual(["updatedAt", "title", "position"]);
    expect(result?.metadataFields).toEqual(["videoPreview", "hasAudio", "generateAudio", "watermark"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("899");
});

test("malformed legacy baseline nodes do not make diagnostics throw or unblock edits", () => {
    for (const nodes of [undefined, null, {}, [null]]) {
        const confirmed = { ...base, nodes } as unknown as CanvasProject;
        expect(canvasUnconfirmedReason({ ...clean, confirmed })).toBe("confirmed-diff");
        expect(() => canvasUnconfirmedDiagnostic({ ...clean, confirmed })).not.toThrow();
        expect(canvasUnconfirmedDiagnostic({ ...clean, confirmed })?.reason).toBe("confirmed-diff");
    }
});


test("diagnostic collection and logger failures never replace the original canvas-dirty rejection", () => {
    // Separate process prevents module mocks from contaminating other repository tests.
    const script = `
        import { mock } from "bun:test";
        let failCollection = true;
        mock.module("@/services/local-workspace-repository", () => ({
            getUnconfirmedCanvasDiagnostic() {
                if (failCollection) throw new Error("damaged legacy journal");
                return { reason: "confirmed-diff", fields: ["nodes"], nodeFields: [], metadataFields: [] };
            },
            hasUnconfirmedCanvasEdits() { return true; },
            readLocalCanvasProjectFromBackend() { throw new Error("not used"); }
        }));
        let writes = 0;
        mock.module("@/services/diagnostics/client-diagnostics", () => ({
            recordDiagnosticEvent() { writes++; throw new Error("diagnostic storage unavailable"); }
        }));
        const { recordAssistantProposalCanvasRejection } = await import("@/pages/canvas/canvas-assistant-proposal-source");
        const original = new Error("canvas-dirty");
        for (const failure of [true, false]) {
            failCollection = failure;
            let actual;
            try {
                try { throw original; } catch (error) { recordAssistantProposalCanvasRejection("private-canvas"); throw error; }
            } catch (error) { actual = error; }
            if (actual !== original) throw new Error("diagnostic replaced original rejection");
        }
        if (writes !== 1) throw new Error("logger failure branch not exercised");
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});


test("root diagnostics retain missing versus empty default document semantics", () => {
    const confirmed = { ...base, chatSessions: undefined, activeChatId: undefined } as unknown as CanvasProject;
    const live = { ...base, title: "new-private-title" };
    const result = canvasUnconfirmedDiagnostic({ ...clean, confirmed, live });
    expect(result?.fields).toEqual(["title"]);
});
