import { afterEach, expect, test } from "bun:test";
import axios, { AxiosError } from "axios";
import { assertChannelBlob, assertChannelPayload, ChannelResponseError, createChannelTransport, normalizeChannelFailure } from "../src/services/api/channel-transport";
import { parseImagePayload, readAxiosError as readImageError } from "../src/services/api/image-response";
import { unwrapEnvelope, assertVideoBlob, readAxiosError as readVideoError } from "../src/services/api/video-response";

const adapter = axios.defaults.adapter;
afterEach(() => {
    axios.defaults.adapter = adapter;
});
const transport = () => createChannelTransport({ baseUrl: "https://example.invalid/v1", apiKey: "synthetic-only", apiFormat: "openai" }, "image");
const rejectedPayload = { error: { code: "content_policy_violation", message: "blocked by content safety policy" }, request_id: "request-probe-123" };

test("HTTP 200 business rejection preserves normalized code and request ID", async () => {
    axios.defaults.adapter = async (config) => ({ config, data: rejectedPayload, status: 200, statusText: "OK", headers: {} });
    try {
        await transport().postJson("https://example.invalid/v1/images/generations", {});
        throw new Error("accepted rejected response");
    } catch (error) {
        expect(error).toBeInstanceOf(ChannelResponseError);
        expect((error as ChannelResponseError).code).toBe("content_policy_violation");
        expect((error as ChannelResponseError).requestId).toBe("request-probe-123");
    }
});

test("explicit error strings and success false cannot become empty media or phantom task", () => {
    for (const payload of [{ error: "upstream unavailable" }, { success: false, message: "quota exhausted" }, rejectedPayload]) {
        expect(() => parseImagePayload(payload as never)).toThrow(ChannelResponseError);
        expect(() => unwrapEnvelope(payload, "missing task")).toThrow(ChannelResponseError);
    }
    expect(() => assertChannelPayload({ data: { error: "rejected" } })).toThrow(ChannelResponseError);
});

test("valid zero and 200 success envelopes and normal task remain accepted", () => {
    for (const code of [0, 200]) {
        const data = { id: "task-success" };
        expect(unwrapEnvelope({ code, data, msg: "ok" }, "missing")).toBe(data);
        expect(parseImagePayload({ code, data: [{ url: "https://example.invalid/image.png" }] } as never)).toHaveLength(1);
    }
    expect(() => assertChannelPayload({ id: "task-success", status: "processing", error: null })).not.toThrow();
});

test("HTTP 200 JSON blob is rejected instead of returned as audio or video", async () => {
    axios.defaults.adapter = async (config) => ({ config, data: new Blob([JSON.stringify(rejectedPayload)], { type: "application/json" }), status: 200, statusText: "OK", headers: {} });
    await expect(transport().postBlob("https://example.invalid/v1/audio/speech", {})).rejects.toBeInstanceOf(ChannelResponseError);
    await expect(transport().getExternalBlob("https://example.invalid/output")).rejects.toBeInstanceOf(ChannelResponseError);
    await expect(assertVideoBlob(new Blob(["{}"], { type: "application/json" }))).rejects.toBeInstanceOf(ChannelResponseError);
});

test("non-2xx blob errors decode once within bound without retaining Axios secrets", async () => {
    const config = { headers: { Authorization: "Bearer PRIVATE_SENTINEL" } } as never;
    const response = { config, data: new Blob([JSON.stringify(rejectedPayload)], { type: "application/json" }), status: 451, statusText: "Unavailable", headers: {} };
    try {
        await normalizeChannelFailure(new AxiosError("rejected", "ERR_BAD_RESPONSE", config, undefined, response));
    } catch (error) {
        expect(error).toBeInstanceOf(ChannelResponseError);
        expect((error as ChannelResponseError).code).toBe("content_policy_violation");
        expect(JSON.stringify(error)).not.toContain("PRIVATE_SENTINEL");
    }
});

test("malformed or oversized JSON and HTML never masquerade as media; reads bounded", async () => {
    class GuardedBlob extends Blob {
        override text(): Promise<string> {
            throw new Error("unbounded read");
        }
        override slice(start?: number, end?: number, type?: string): Blob {
            expect(end! - (start || 0)).toBeLessThanOrEqual(16 * 1024);
            return super.slice(start, end, type);
        }
    }
    for (const blob of [new GuardedBlob(["{" + "x".repeat(50_000)], { type: "application/json" }), new Blob(["<html>bad gateway</html>"], { type: "text/html" }), new Blob([JSON.stringify(rejectedPayload)], { type: "application/octet-stream" })]) {
        await expect(assertChannelBlob(blob)).rejects.toBeInstanceOf(ChannelResponseError);
    }
    await expect(assertChannelBlob(new Blob([new Uint8Array([0, 1, 2])], { type: "audio/mpeg" }))).resolves.toBeUndefined();
});

test("cancellation identity survives transport normalization", async () => {
    const aborted = new DOMException("Aborted", "AbortError");
    await expect(normalizeChannelFailure(aborted)).rejects.toBe(aborted);
    const cancelled = new axios.CanceledError("cancelled");
    await expect(normalizeChannelFailure(cancelled)).rejects.toBe(cancelled);
});

test("legacy image/video catch wrappers cannot flatten structured errors", () => {
    for (const error of [new ChannelResponseError(rejectedPayload, 451), new DOMException("Aborted", "AbortError"), new axios.CanceledError("cancelled")])
        for (const reader of [readImageError, readVideoError]) {
            try {
                throw new Error(reader(error, "fallback"));
            } catch (caught) {
                expect(caught).toBe(error);
            }
        }
});
