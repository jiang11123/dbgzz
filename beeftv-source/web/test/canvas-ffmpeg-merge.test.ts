import { afterEach, beforeEach, expect, mock, test } from "bun:test";

(globalThis as { __BEEFTV_HEAVY_MEDIA_ENABLED__?: boolean }).__BEEFTV_HEAVY_MEDIA_ENABLED__ = true;

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function isoBmff() {
    const writeAscii = (bytes: Uint8Array, offset: number, value: string) => {
        for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
    };
    const box = (type: string, payload: Uint8Array) => {
        const bytes = new Uint8Array(8 + payload.byteLength);
        new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
        writeAscii(bytes, 4, type);
        bytes.set(payload, 8);
        return bytes;
    };
    const concat = (parts: Uint8Array[]) => {
        const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
        }
        return bytes;
    };
    const hdlr = new Uint8Array(24);
    writeAscii(hdlr, 8, "vide");
    const stsz = new Uint8Array(12);
    new DataView(stsz.buffer).setUint32(8, 1);
    const stts = new Uint8Array(16);
    new DataView(stts.buffer).setUint32(4, 1);
    new DataView(stts.buffer).setUint32(8, 1);
    return concat([
        box("ftyp", new TextEncoder().encode("isom")),
        box("mdat", new Uint8Array(48)),
        box("moov", box("trak", box("mdia", concat([
            box("hdlr", hdlr),
            box("minf", box("stbl", concat([box("stsz", stsz), box("stts", stts)]))),
        ])))),
    ]);
}

const videoBytes = isoBmff();
const instances: FakeFFmpeg[] = [];

class FakeFFmpeg {
    terminated = false;
    written: string[] = [];
    execCount = 0;
    readonly started = deferred();
    private blocked: { resolve: (code: number) => void; reject: (error: unknown) => void }[] = [];
    constructor() { instances.push(this); }
    async load() {}
    on() {}
    async writeFile(name: string) { this.written.push(name); }
    async readFile() { return videoBytes; }
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

mock.module("@ffmpeg/ffmpeg", () => ({ FFmpeg: FakeFFmpeg }));
mock.module("@ffmpeg/util", () => ({ fetchFile: async () => new Uint8Array([1]) }));
mock.module("@ffmpeg/core?url", () => ({ default: "core.js" }));
mock.module("@ffmpeg/core/wasm?url", () => ({ default: "core.wasm" }));
mock.module("@/services/file-storage", () => ({ getMediaBlob: async () => new Blob(["fixture"], { type: "video/mp4" }) }));

const { mergeVideos, loadFFmpeg, warmFFmpeg } = await import("../src/lib/canvas/canvas-video-merge");
const { trimVideoSegment } = await import("../src/lib/canvas/canvas-video-segment");
const { resetCanvasFFmpegSessionForTests } = await import("../src/lib/canvas/canvas-ffmpeg-session");

const inputs = [
    { id: "a", storageKey: "video:a" },
    { id: "b", storageKey: "video:b" },
];

async function worker(index: number) {
    for (let attempt = 0; attempt < 50 && !instances[index]; attempt += 1) await Promise.resolve();
    if (!instances[index]) throw new Error(`ffmpeg worker ${index} was not created`);
    await instances[index].started.promise;
    return instances[index];
}

beforeEach(() => {
    instances.length = 0;
    resetCanvasFFmpegSessionForTests();
});
afterEach(() => {
    resetCanvasFFmpegSessionForTests();
});

test("canceling a queued merge does not terminate the active merge worker", async () => {
    const first = mergeVideos(inputs);
    const activeWorker = await worker(0);
    const queued = new AbortController();
    const second = mergeVideos(inputs, undefined, queued.signal);
    queued.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(instances).toHaveLength(1);
    expect(activeWorker.terminated).toBe(false);
    activeWorker.finish(0);
    const blob = await first;
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBeGreaterThan(0);
    expect(activeWorker.written.some((name) => /^s1_input-0\.mp4$/.test(name))).toBe(true);
    expect(activeWorker.terminated).toBe(false);
});

test("canceling an active merge then retrying uses a new worker", async () => {
    const active = new AbortController();
    const first = mergeVideos(inputs, undefined, active.signal);
    const firstWorker = await worker(0);
    active.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(firstWorker.terminated).toBe(true);

    const retry = mergeVideos(inputs);
    const retryWorker = await worker(1);
    retryWorker.finish(0);
    const blob = await retry;
    expect(blob.size).toBeGreaterThan(0);
    expect(instances).toHaveLength(2);
    expect(retryWorker.terminated).toBe(false);
    expect(retryWorker.written.some((name) => name.startsWith("s2_"))).toBe(true);
});

test("trim waits behind merge and aborting merge does not kill the queued trim once it runs", async () => {
    const mergeAbort = new AbortController();
    const merging = mergeVideos(inputs, undefined, mergeAbort.signal);
    const mergeWorker = await worker(0);
    const trim = trimVideoSegment({ storageKey: "video:a" }, { startMs: 0, endMs: 1000 }, 2000);
    mergeAbort.abort();
    await expect(merging).rejects.toMatchObject({ name: "AbortError" });
    const trimWorker = await worker(1);
    trimWorker.finish(0);
    const blob = await trim;
    expect(blob.type).toBe("video/mp4");
    expect(mergeWorker.terminated).toBe(true);
    expect(trimWorker.terminated).toBe(false);
});

test("warmFFmpeg parks an idle worker that merge can steal", async () => {
    const warmed = await warmFFmpeg();
    expect(instances).toHaveLength(1);
    const merging = mergeVideos(inputs);
    await instances[0].started.promise;
    expect(warmed).toBe(instances[0]);
    expect(instances).toHaveLength(1);
    instances[0].finish(0);
    await merging;
    expect(await loadFFmpeg()).toBe(instances[0]);
});
