import { afterEach, expect, test } from "bun:test";
import { createFFmpegSession, type FFmpegInstance } from "../src/lib/canvas/canvas-ffmpeg-session";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class FakeFFmpeg {
    terminated = false;
    execCount = 0;
    written: string[] = [];
    private blocked: { resolve: (code: number) => void; reject: (error: unknown) => void }[] = [];
    readonly started = deferred();

    async load() {}
    async writeFile(name: string) { this.written.push(name); }
    async readFile() { return new Uint8Array([1]); }
    async deleteFile() {}
    async exec() {
        this.execCount += 1;
        this.started.resolve();
        return new Promise<number>((resolve, reject) => {
            if (this.terminated) {
                reject(new Error("terminated"));
                return;
            }
            this.blocked.push({ resolve, reject });
        });
    }
    finish(code = 0) {
        const blocked = this.blocked.splice(0);
        for (const item of blocked) item.resolve(code);
    }
    terminate() {
        this.terminated = true;
        const blocked = this.blocked.splice(0);
        for (const item of blocked) item.reject(new Error("terminated"));
    }
}

let sessions: ReturnType<typeof createFFmpegSession>[] = [];

afterEach(() => {
    for (const session of sessions) session.dispose();
    sessions = [];
});

function sessionWithWorkers() {
    const workers: FakeFFmpeg[] = [];
    const session = createFFmpegSession({
        spawn: async () => {
            const worker = new FakeFFmpeg();
            workers.push(worker);
            return worker as unknown as FFmpegInstance;
        },
    });
    sessions.push(session);
    return { session, workers };
}

test("queued abort rejects immediately and does not terminate the running worker", async () => {
    const { session, workers } = sessionWithWorkers();
    const firstHold = deferred();
    const firstStarted = deferred();
    const first = session.withLease(async ({ filePrefix }) => {
        firstStarted.resolve();
        await firstHold.promise;
        return filePrefix;
    });
    await firstStarted.promise;
    const queued = new AbortController();
    const second = session.withLease(async () => "queued-ran", { signal: queued.signal });
    queued.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    firstHold.resolve();
    const prefix = await first;
    expect(prefix).toBe("s1_");
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
});

test("active abort terminates only that worker; retry uses a fresh worker", async () => {
    const { session, workers } = sessionWithWorkers();
    const active = new AbortController();
    const first = session.withLease(async ({ ffmpeg }) => {
        await ffmpeg.exec(["-i", "in.mp4"]);
        return "first";
    }, { signal: active.signal });
    await workers[0].started.promise;
    active.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].terminated).toBe(true);

    const retry = session.withLease(async ({ ffmpeg, filePrefix }) => {
        expect(ffmpeg).not.toBe(workers[0]);
        (ffmpeg as unknown as FakeFFmpeg).finish(0);
        return filePrefix;
    });
    const prefix = await retry;
    expect(prefix).toBe("s2_");
    expect(workers).toHaveLength(2);
    expect(workers[1].terminated).toBe(false);
});

test("simultaneous leases serialize and use distinct file prefixes", async () => {
    const { session, workers } = sessionWithWorkers();
    const prefixes: string[] = [];
    const firstHold = deferred();
    const firstStarted = deferred();
    const first = session.withLease(async ({ filePrefix, ffmpeg }) => {
        prefixes.push(filePrefix);
        await ffmpeg.writeFile(`${filePrefix}input-0.mp4`, new Uint8Array([1]));
        firstStarted.resolve();
        await firstHold.promise;
        return "a";
    });
    const second = session.withLease(async ({ filePrefix, ffmpeg }) => {
        prefixes.push(filePrefix);
        await ffmpeg.writeFile(`${filePrefix}input-0.mp4`, new Uint8Array([2]));
        return "b";
    });
    await firstStarted.promise;
    expect(prefixes).toEqual(["s1_"]);
    firstHold.resolve();
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(prefixes).toEqual(["s1_", "s2_"]);
    expect(workers).toHaveLength(1);
    expect(workers[0].written).toEqual(["s1_input-0.mp4", "s2_input-0.mp4"]);
});

test("prewarm during an active lease parks a separate idle worker", async () => {
    const { session, workers } = sessionWithWorkers();
    const hold = deferred();
    const started = deferred();
    const running = session.withLease(async ({ ffmpeg }) => {
        started.resolve();
        await hold.promise;
        return ffmpeg;
    });
    await started.promise;
    const warmed = await session.prewarm();
    expect(workers).toHaveLength(2);
    expect(warmed).toBe(workers[1]);
    expect(warmed).not.toBe(workers[0]);
    expect(workers[0].terminated).toBe(false);
    hold.resolve();
    const leased = await running;
    expect(leased).toBe(workers[0]);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].terminated).toBe(false);
});

test("abort listeners are removed after settle and do not fire on a later abort", async () => {
    const { session, workers } = sessionWithWorkers();
    const signal = new AbortController();
    const done = session.withLease(async () => "ok", { signal: signal.signal });
    expect(await done).toBe("ok");
    const terminatedAfterSuccess = workers[0].terminated;
    signal.abort();
    await Promise.resolve();
    expect(workers[0].terminated).toBe(terminatedAfterSuccess);
});

test("a queued lease can claim a pending prewarm after the active worker is cancelled", async () => {
    const firstWorker = new FakeFFmpeg();
    const nextWorker = new FakeFFmpeg();
    const warmReady = deferred<FFmpegInstance>();
    let spawns = 0;
    const session = createFFmpegSession({ spawn: async () => ++spawns === 1 ? firstWorker as unknown as FFmpegInstance : warmReady.promise });
    sessions.push(session);
    const active = new AbortController();
    const running = session.withLease(async ({ ffmpeg }) => ffmpeg.exec([]), { signal: active.signal });
    await firstWorker.started.promise;
    const warming = session.prewarm();
    const next = session.withLease(async ({ ffmpeg }) => {
        expect(ffmpeg).toBe(nextWorker);
        expect(nextWorker.terminated).toBe(false);
        return "usable";
    });
    active.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    warmReady.resolve(nextWorker as unknown as FFmpegInstance);
    await warming;
    expect(await next).toBe("usable");
});

test("dispose during a pending spawn rejects the owner and destroys late workers", async () => {
    const ready = deferred<FFmpegInstance>();
    const worker = new FakeFFmpeg();
    const session = createFFmpegSession({ spawn: () => ready.promise });
    sessions.push(session);
    const work = session.withLease(async () => { throw new Error("disposed work ran"); });
    session.dispose();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    ready.resolve(worker as unknown as FFmpegInstance);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.terminated).toBe(true);
    await expect(session.withLease(async () => "new")).rejects.toMatchObject({ name: "AbortError" });
});

test("cancel during loading rejects promptly and disposes the late worker", async () => {
    const ready = deferred<FFmpegInstance>();
    const worker = new FakeFFmpeg();
    const session = createFFmpegSession({ spawn: () => ready.promise });
    sessions.push(session);
    const abort = new AbortController();
    const work = session.withLease(async () => { throw new Error("cancelled work ran"); }, { signal: abort.signal });
    abort.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    ready.resolve(worker as unknown as FFmpegInstance);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.terminated).toBe(true);
});
