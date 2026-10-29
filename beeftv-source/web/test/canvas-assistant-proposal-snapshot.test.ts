import { expect, test } from "bun:test";
import { ASSISTANT_PROPOSAL_BLOCKED_TEXT, AssistantProposalBlockedError, prepareAssistantProposalSnapshot, type AssistantProposalBlockedReason, type ProposalSourceState } from "@/pages/canvas/canvas-assistant-proposal-snapshot";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { executeAssistantProposal } from "@/pages/canvas/canvas-assistant-proposal-execution";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { normalizeCanvasNodeTimestamps } from "@/lib/canvas/canvas-node-timestamps";
import { resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { resourceFileUrl } from "@/services/api/resources";

const proposal = { proposalId: "p", kind: "image" as const, model: "m", modelKey: "c::m", nodeIds: ["n"],
    source: { canvasId: "canvas", canvasRevision: 4, modelConfigRevision: 2 } };
function fixture(): ProposalSourceState {
    return structuredClone({ ...proposal.source, canvasHasUnconfirmedEdits: false, modelConfigHasUnconfirmedEdits: false,
        nodes: [{ id: "n", title: "Image", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "original" } },
            { id: "ref", title: "Reference", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "resource:r1" } }],
        connections: [{ id: "edge", fromNodeId: "ref", toNodeId: "n" }], config: defaultConfig, assets: [], skills: [] });
}

test("normal freshly loaded React nodes pass against raw server nodes", async () => {
    const persisted = fixture();
    const live = fixture();
    live.nodes = normalizeCanvasMediaNodeSemanticsList(normalizeCanvasNodeTimestamps(resetInterruptedGeneration(live.nodes), {
        createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:01:00Z",
    }));
    live.nodes[1].metadata!.content = resourceFileUrl("r1");
    live.nodes[0].metadata!.resultOrigin = undefined;
    const result = await prepareAssistantProposalSnapshot(proposal, () => live, async () => persisted);
    expect(result.nodes[0].metadata?.prompt).toBe("original");
});

const noWait = { sleep: async () => {} };

const mutations: [string, (state: ProposalSourceState) => void][] = [
    ["prompt before persistence", s => { s.nodes[0].metadata!.prompt = "changed"; }],
    ["reference resource", s => { s.nodes[1].metadata!.storageKey = "resource:r2"; }],
    ["reference remote URL", s => { s.nodes[1].metadata!.content = "https://example.test/changed.png"; }],
    ["reference connection", s => { s.connections = []; }],
    ["saved canvas revision", s => { s.canvasRevision++; }],
    ["global settings with unchanged model", s => { s.modelConfigRevision++; }],
    ["unsaved settings", s => { s.modelConfigHasUnconfirmedEdits = true; }],
    ["canvas save that never settles", s => { s.canvasHasUnconfirmedEdits = true; }],
    ["different canvas", s => { s.canvasId = "other"; }],
];
for (const [label, change] of mutations) test(`F02 rejects ${label} before any task is submitted`, async () => {
    const persisted = fixture();
    const live = fixture();
    change(live);
    let submissions = 0;
    let handled = 0;
    const claims = new Set<string>();
    const notices: string[] = [];
    await executeAssistantProposal({ proposal, nodes: live.nodes, claims, isHandled: false,
        prepare: () => prepareAssistantProposalSnapshot(proposal, () => live, async () => persisted, noWait),
        generate: async () => { submissions++; }, markHandled: () => { handled++; }, notify: text => { notices.push(text); } });
    expect(submissions).toBe(0);
    expect(handled).toBe(0);
    expect(claims.size).toBe(0);
    expect(notices).toHaveLength(1);
});

test("a remote save while the editor is stale rejects confirmation", async () => {
    const live = fixture();
    const server = fixture();
    server.canvasRevision++;
    await expect(prepareAssistantProposalSnapshot(proposal, () => live, async () => server)).rejects.toThrow();
});

for (const [label, change] of [
    ["prompt", (s: ProposalSourceState) => { s.nodes[0].metadata!.prompt = "new"; }],
    ["global parameters", (s: ProposalSourceState) => { s.config.canvasImageCount = "4"; }],
] as const) test(`editing ${label} while the server read is pending rejects`, async () => {
    const live = fixture();
    await expect(prepareAssistantProposalSnapshot(proposal, () => live, async () => {
        const persisted = fixture(); change(live); return persisted;
    })).rejects.toThrow();
});

test("confirmed inputs remain unchanged after subsequent live edits", async () => {
    const live = fixture();
    const savedCount = live.config.canvasImageCount;
    const confirmed = await prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture());
    live.nodes[0].metadata!.prompt = "later";
    live.nodes[1].metadata!.storageKey = "resource:later";
    live.connections.length = 0;
    live.config.canvasImageCount = "4";
    expect(confirmed.nodes[0].metadata!.prompt).toBe("original");
    expect(confirmed.nodes[1].metadata!.storageKey).toBe("resource:r1");
    expect(confirmed.connections).toHaveLength(1);
    expect(confirmed.config.canvasImageCount).toBe(savedCount);
});

test("old history and malformed source cannot invent a current baseline", async () => {
    for (const source of [undefined, null, {}, { ...proposal.source, canvasRevision: "4" }, { ...proposal.source, modelConfigRevision: -1 }]) {
        await expect(prepareAssistantProposalSnapshot({ ...proposal, source } as typeof proposal, fixture, async () => fixture())).rejects.toThrow();
    }
});

test("failed durable read cannot execute with local fallback", async () => {
    await expect(prepareAssistantProposalSnapshot(proposal, fixture, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
});

test("the generation boundary receives the confirmed prompt and reference after live mutation", async () => {
    const live = fixture();
    let submitted = false;
    await executeAssistantProposal({ proposal, nodes: live.nodes, claims: new Set(), isHandled: false,
        prepare: async () => {
            const frozen = await prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture());
            live.nodes[0].metadata!.prompt = "later prompt";
            live.nodes[1].metadata!.storageKey = "resource:later";
            live.config.canvasImageCount = "4";
            return frozen;
        },
        generate: async (id, _mode, prompt, options) => {
            const frozen = options!.confirmedInputs!;
            const context = buildNodeGenerationContext(id, frozen.nodes, frozen.connections, prompt, frozen.assets);
            expect(prompt).toBe("original");
            expect(frozen.nodes[1].metadata!.storageKey).toBe("resource:r1");
            expect(context.prompt).toContain("original");
            expect(frozen.config.canvasImageCount).toBe(defaultConfig.canvasImageCount);
            submitted = true;
        }, markHandled: () => {}, notify: () => {} });
    expect(submitted).toBe(true);
});

async function blockedReason(run: Promise<unknown>): Promise<AssistantProposalBlockedReason | "passed" | "other"> {
    try {
        await run;
        return "passed";
    } catch (error) {
        return error instanceof AssistantProposalBlockedError ? error.reason : "other";
    }
}

const reasonCases: [string, AssistantProposalBlockedReason, (live: ProposalSourceState, persisted: ProposalSourceState) => void][] = [
    ["canvas save still pending after the wait", "canvas_saving", live => { live.canvasHasUnconfirmedEdits = true; }],
    ["generation settings unsaved or saving", "settings_unsaved", live => { live.modelConfigHasUnconfirmedEdits = true; }],
    ["editor canvas revision moved", "canvas_changed", live => { live.canvasRevision++; }],
    ["editor on a different canvas", "canvas_changed", live => { live.canvasId = "other"; }],
    ["saved canvas revision moved", "canvas_changed", (_live, persisted) => { persisted.canvasRevision++; }],
    ["editor settings revision moved", "settings_changed", live => { live.modelConfigRevision++; }],
    ["saved settings revision moved", "settings_changed", (_live, persisted) => { persisted.modelConfigRevision++; }],
    ["editor shows nodes the server no longer has", "content_mismatch", (_live, persisted) => { persisted.nodes = persisted.nodes.slice(0, 1); persisted.connections = []; }],
    ["editor prompt differs from the saved canvas", "content_mismatch", live => { live.nodes[0].metadata!.prompt = "changed"; }],
];
for (const [label, reason, change] of reasonCases) test(`blocked reason: ${label} -> ${reason}`, async () => {
    const live = fixture();
    const persisted = fixture();
    change(live, persisted);
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => live, async () => persisted, noWait))).toBe(reason);
});

test("blocked reason: malformed or missing source -> invalid_source", async () => {
    for (const source of [undefined, null, {}, { ...proposal.source, canvasRevision: "4" }, { ...proposal.source, modelConfigRevision: -1 }]) {
        expect(await blockedReason(prepareAssistantProposalSnapshot({ ...proposal, source } as typeof proposal, fixture, async () => fixture(), noWait))).toBe("invalid_source");
    }
});

test("blocked reason: a canvas edit during the server read -> canvas_changed; a settings edit -> settings_changed", async () => {
    const editPrompt = fixture();
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => editPrompt, async () => {
        const persisted = fixture(); editPrompt.nodes[0].metadata!.prompt = "new"; return persisted;
    }, noWait))).toBe("canvas_changed");
    const editSettings = fixture();
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => editSettings, async () => {
        const persisted = fixture(); editSettings.config.canvasImageCount = "4"; return persisted;
    }, noWait))).toBe("settings_changed");
});

test("blocked error message is the user copy for its reason", () => {
    for (const reason of Object.keys(ASSISTANT_PROPOSAL_BLOCKED_TEXT) as AssistantProposalBlockedReason[]) {
        expect(new AssistantProposalBlockedError(reason).message).toBe(ASSISTANT_PROPOSAL_BLOCKED_TEXT[reason]);
    }
});

test("a pending canvas save that settles within the wait continues to confirmation", async () => {
    const live = fixture();
    live.canvasHasUnconfirmedEdits = true;
    const sleeps: number[] = [];
    const confirmed = await prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture(), {
        saveWaitMs: 3000, pollMs: 250,
        sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 3) live.canvasHasUnconfirmedEdits = false; },
    });
    expect(sleeps).toEqual([250, 250, 250]);
    expect(confirmed.nodes[0].metadata?.prompt).toBe("original");
});

test("a pending canvas save gives up after the wait budget with canvas_saving", async () => {
    const live = fixture();
    live.canvasHasUnconfirmedEdits = true;
    let reads = 0;
    let slept = 0;
    let persistedReads = 0;
    const reason = await blockedReason(prepareAssistantProposalSnapshot(proposal, () => { reads++; return live; }, async () => { persistedReads++; return fixture(); }, {
        saveWaitMs: 3000, pollMs: 250, sleep: async (ms) => { slept += ms; },
    }));
    expect(reason).toBe("canvas_saving");
    expect(slept).toBe(3000);
    expect(reads).toBe(13);
    expect(persistedReads).toBe(0);
});

test("a clean stale local model revision accepts an identical authoritative config", async () => {
    const live = fixture();
    live.modelConfigRevision = 1;
    const confirmed = await prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture());
    expect(confirmed.config).toEqual(live.config);
});

test("a stale local model revision cannot generate using stale settings", async () => {
    const live = fixture();
    live.modelConfigRevision = 1;
    const saved = fixture();
    saved.config.canvasImageCount = "4";
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => live, async () => saved))).toBe("settings_changed");
});

test("an unrelated asset finishing during confirmation does not invalidate the proposal", async () => {
    const live = fixture();
    const result = await prepareAssistantProposalSnapshot(proposal, () => live, async () => {
        live.assets.push({ id: "unrelated", kind: "text", title: "Other result", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { content: "elsewhere" } });
        return fixture();
    });
    expect(result.assets).toHaveLength(1);
    live.assets[0].title = "later";
    expect(result.assets[0].title).toBe("Other result");
});

test("a referenced asset changing during confirmation still blocks generation", async () => {
    const live = fixture();
    live.nodes[0].metadata!.prompt = "使用 @[asset:script]";
    live.assets.push({ id: "script", kind: "text", title: "剧本", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { content: "原剧情" } });
    const saved = structuredClone(live);
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => live, async () => {
        const asset = live.assets[0];
        if (asset.kind === "text") asset.data.content = "已改剧情";
        return saved;
    }))).toBe("content_mismatch");
});

test("a paused conflict reports recovery instead of waiting for a nonexistent save", async () => {
    const live = { ...fixture(), canvasHasUnconfirmedEdits: true, canvasUnconfirmedReason: "blocked" };
    let slept = 0;
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture(), {
        sleep: async (ms) => { slept += ms; },
    }))).toBe("canvas_conflict");
    expect(slept).toBe(0);
});

test("unsaved generation settings fail at once without waiting", async () => {
    const live = fixture();
    live.modelConfigHasUnconfirmedEdits = true;
    live.canvasHasUnconfirmedEdits = true;
    let slept = 0;
    expect(await blockedReason(prepareAssistantProposalSnapshot(proposal, () => live, async () => fixture(), {
        sleep: async (ms) => { slept += ms; },
    }))).toBe("settings_unsaved");
    expect(slept).toBe(0);
});
