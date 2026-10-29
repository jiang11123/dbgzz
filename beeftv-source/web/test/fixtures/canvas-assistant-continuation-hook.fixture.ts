import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// Isolated deterministic hook/timer adapter: production hook control flow runs
// unchanged. This is not browser/React rendering acceptance.
const slots: any[] = [];
let cursor = 0, renderPending = false;
let effects: (() => void)[] = [];
const same = (a: any[] | undefined, b: any[] | undefined) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
mock.module("react", () => ({
    useRef(value: any) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value: any) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof value === "function" ? value() : value;
        return [slots[index], (next: any) => { const value = typeof next === "function" ? next(slots[index]) : next; if (!Object.is(value, slots[index])) { slots[index] = value; renderPending = true; } }];
    },
    useEffect(effect: () => any, deps: any[]) {
        const index = cursor++, prior = slots[index];
        if (prior && same(prior.deps, deps)) return;
        effects.push(() => { prior?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
    useCallback(fn: any, deps: any[]) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = {deps, fn}; return slots[index].fn; },
}));
let timerId = 0;
const timers = new Map<number, () => void>();
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: () => void) => { timers.set(++timerId, fn); return timerId; }) as any;
globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
class ApiError extends Error { reason = "continuation_waiting"; }
const row = { id:"receipt", canvasId:"canvas", sessionId:"session", proposalId:"gp-one", sourceTurnId:"source", requestId:"fixed", turnId:"fixed", message:"自动继续", permissionMode:"canvas", state:"waiting", taskIds:["task"], nodeIds:["output"] };
let claimCount = 0, sends = 0, terminal = false, taskListener = () => {};
let rejectWaiting!: (error: Error) => void;
const delayedWaiting = new Promise<never>((_, reject) => { rejectWaiting = reject; });
mock.module("@/services/api/request", () => ({ApiError}));
mock.module("@/services/api/assistant-continuation", () => ({
    listAssistantContinuations: async () => [row],
    claimAssistantContinuation: async () => { claimCount++; if (claimCount === 1) return delayedWaiting; assert.equal(terminal, true); return {...row,state:"claimed"}; },
    cancelAssistantContinuations: async () => {},
}));
mock.module("@/services/api/task-center", () => ({subscribeGenerationTasks: (_ids: string[], listener: () => void) => {taskListener = listener; return () => {};}}));
mock.module("@/lib/user-scope-guard", () => ({captureUserScope: () => "owner", userScopeMatches: () => true}));
mock.module("@/services/api/agent-assistant", () => ({cancelAgentChat: async () => {}}));
const { useCanvasAssistantContinuation } = await import("@/pages/canvas/use-canvas-assistant-continuation");
let nodes: any[] = [];
const controller: any = {canvasId:"canvas",sessionId:"session",historyLoaded:true,streaming:false,sessionBusy:false,awaitingReceipt:false,reloadHistory:async()=>{},send:async()=>{sends++;}};
let result: ReturnType<typeof useCanvasAssistantContinuation>;
function render() { cursor = 0; renderPending = false; effects = []; result = useCanvasAssistantContinuation(controller,nodes,true); for (const effect of effects) effect(); }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (renderPending) render(); } }
async function tick() { const due = [...timers.values()]; timers.clear(); for (const callback of due) callback(); await flush(); }
try {
    render(); await flush(); await tick();
    assert.equal(claimCount,1);
    // Go already read waiting, but its reply is delayed across the only terminal
    // task event and saved-canvas render. No later event will rescue the hook.
    terminal = true; taskListener(); nodes = [{id:"output",metadata:{status:"success"}}]; render(); await flush(); await tick();
    assert.equal(claimCount,1);
    rejectWaiting(new ApiError("waiting")); await flush(); await tick();
    assert.equal(claimCount,2,"a terminal wakeup during checking must trigger a fresh read");
    assert.equal(sends,1,"only the fixed receipt may be dispatched once");
    await tick(); await flush(); assert.equal(sends,1);
    console.log("PASS: actual continuation hook retains its only terminal wakeup and dispatches once");
} finally {
    for (const slot of slots) slot?.cleanup?.();
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
}
