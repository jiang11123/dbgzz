import type { ClientDiagnosticEvent } from "./client-diagnostics";

export type ClientDiagnosticCoverage = {
    status: "available" | "partial" | "unavailable";
    launchId: string;
    sessionCount: number;
    retainedCount: number;
    exportedCount: number;
    droppedCount: number;
    expiredCount: number;
    writeErrorCount: number;
    readErrorCount: number;
    oldestAt?: string;
    newestAt?: string;
    maxAgeHours: number;
    maxEvents: number;
    maxBytes: number;
    persisted: boolean;
};

type SavedEvents = { version: 1; events: ClientDiagnosticEvent[]; droppedCount: number; expiredCount: number; writeErrorCount: number; readErrorCount: number };
type Storage = { getItem(name: string): unknown; setItem(name: string, value: string): unknown };
type ScopeState = SavedEvents & { ready: Promise<void>; writes: Promise<void>; persisted: boolean; revision: number; queued: boolean; readPending: boolean };
const key = "client-diagnostics-v3";
const limits = { maxAgeHours: 24, maxEvents: 500, maxBytes: 512 * 1024 };

/** A captured state owns its storage queue even after the visible user changes. */
export function createDiagnosticEventStore(options: {
    storage(scope: string): Storage;
    sanitize(event: ClientDiagnosticEvent): ClientDiagnosticEvent;
    launchId: string;
    now?: () => number;
    timeoutMs?: number;
}) {
    const now = options.now ?? Date.now;
    const scopes = new Map<string, ScopeState>();
    let current: ScopeState | undefined;
    let epoch = 0;
    function bounded<T>(job: Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("diagnostic_storage_timeout")), options.timeoutMs ?? 2000);
            job.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
    }
    function trim(state: ScopeState) {
        const cutoff = now() - limits.maxAgeHours * 3600_000;
        const before = state.events.length;
        state.events = state.events.filter(event => Number.isFinite(Date.parse(event.timestamp)) && Date.parse(event.timestamp) >= cutoff && Date.parse(event.timestamp) <= now() + 60_000);
        state.expiredCount += before - state.events.length;
        const bytes = () => new TextEncoder().encode(JSON.stringify(state.events)).byteLength;
        while (state.events.length > limits.maxEvents || bytes() > limits.maxBytes) {
            const routine = state.events.findIndex(event => event.category === "request" && event.level === "info" && event.code !== "request_started");
            state.events.splice(routine >= 0 ? routine : 0, 1);
            state.droppedCount += 1;
        }
    }
    function save(state: ScopeState, storage: Storage) {
        if (state.queued) return;
        state.queued = true;
        state.writes = state.writes.then(async () => {
            await state.ready;
            // A timed-out read is still running. Export the partial in-memory
            // evidence, but never replace history before that read can merge it.
            if (state.readPending) { state.queued = false; return; }
            for (;;) {
                trim(state);
                const revision = state.revision;
                const value: SavedEvents = { version: 1, events: state.events, droppedCount: state.droppedCount, expiredCount: state.expiredCount, writeErrorCount: state.writeErrorCount, readErrorCount: state.readErrorCount };
                const write = Promise.resolve().then(() => storage.setItem(key, JSON.stringify(value)));
                try {
                    await bounded(write);
                    state.persisted = state.revision === revision;
                } catch {
                    state.writeErrorCount += 1;
                    state.persisted = false;
                    // A timeout does not cancel IndexedDB. Keep later writes behind
                    // that physical operation so its late completion cannot overwrite
                    // a newer snapshot with fewer events or older loss counters.
                    void write.then(() => { state.queued = false; save(state, storage); }, () => { state.queued = false; });
                    return;
                }
                if (state.revision === revision) break;
            }
            state.queued = false;
        });
    }
    return {
        setScope(scope: string) {
            epoch += 1;
            let state = scopes.get(scope);
            if (!state) {
                const storage = options.storage(scope);
                state = { version: 1, events: [], droppedCount: 0, expiredCount: 0, writeErrorCount: 0, readErrorCount: 0, ready: Promise.resolve(), writes: Promise.resolve(), persisted: false, revision: 0, queued: false, readPending: true };
                const captured = state;
                let readTimedOut = false;
                const hydration = Promise.resolve().then(() => storage.getItem(key)).then(raw => {
                    if (!raw) { captured.persisted = captured.revision === 0; return; }
                    const saved = JSON.parse(String(raw)) as SavedEvents;
                    if (saved.version !== 1 || !Array.isArray(saved.events)) throw new Error("invalid_diagnostic_store");
                    const existing = new Set(captured.events.map(event => event.id));
                    const restored = saved.events.filter(event => event && typeof event.id === "string" && typeof event.timestamp === "string" && !existing.has(event.id)).map(options.sanitize);
                    captured.events = [...restored, ...captured.events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
                    for (const field of ["droppedCount", "expiredCount", "writeErrorCount", "readErrorCount"] as const) captured[field] += Number.isSafeInteger(saved[field]) && saved[field] >= 0 ? saved[field] : 0;
                    captured.persisted = captured.revision === 0;
                }).finally(() => { captured.readPending = false; });
                captured.ready = bounded(hydration).catch(() => {
                    readTimedOut = captured.readPending;
                    captured.readErrorCount += 1;
                }).then(() => { trim(captured); });
                const finishLateRead = () => { if (readTimedOut) save(captured, storage); };
                void hydration.then(finishLateRead, finishLateRead);
                scopes.set(scope, captured);
            }
            current = state;
        },
        record(event: ClientDiagnosticEvent) {
            if (!current) return;
            current.events.push(event);
            current.revision += 1;
            current.persisted = false;
            trim(current);
            // Writes start immediately; exports await this queue rather than relying on unload.
            const entry = [...scopes.entries()].find(([, state]) => state === current)!;
            save(current, options.storage(entry[0]));
        },
        events(range?: { from?: Date; to?: Date }) {
            if (!current) return [];
            trim(current);
            const from = range?.from?.getTime() ?? -Infinity;
            const to = range?.to?.getTime() ?? Infinity;
            return current.events.filter(event => Date.parse(event.timestamp) >= from && Date.parse(event.timestamp) <= to).map(event => JSON.parse(JSON.stringify(event)) as ClientDiagnosticEvent);
        },
        async snapshot(range?: { from?: Date; to?: Date }) {
            const state = current;
            const capturedEpoch = epoch;
            if (!state) throw new Error("诊断记录尚未初始化");
            await state.ready;
            await state.writes;
            if (current !== state || epoch !== capturedEpoch) throw new Error("账号已切换，请重新导出诊断包");
            trim(state);
            const events = this.events(range);
            const coverage: ClientDiagnosticCoverage = {
                status: state.readErrorCount || state.writeErrorCount || state.droppedCount || state.expiredCount ? "partial" : state.persisted ? "available" : "unavailable",
                launchId: options.launchId,
                sessionCount: new Set(state.events.map(event => event.launchId).filter(Boolean)).size,
                retainedCount: state.events.length, exportedCount: events.length,
                droppedCount: state.droppedCount, expiredCount: state.expiredCount, writeErrorCount: state.writeErrorCount, readErrorCount: state.readErrorCount,
                oldestAt: state.events[0]?.timestamp, newestAt: state.events.at(-1)?.timestamp,
                ...limits, persisted: state.persisted,
            };
            return { events, coverage };
        },
    };
}
