import { createFalClient } from "@fal-ai/client";
import { wma } from "@fal-ai/client/realtime/wma";
import { channelRequest } from "./custom-channel-relay";
import { buildApiUrl } from "@/stores/use-config-store";
import type { ResolvedAiConfig } from "./video-contracts";
import { H3DirectorControl, type H3DirectorConfig, type H3DirectorPhase, type H3DirectorUpdate } from "@/lib/h3-director";

export type H3DirectorConnection = { control: H3DirectorControl; stop: () => Promise<void>; update: (value: H3DirectorUpdate) => void };

export async function openH3Director(
    config: ResolvedAiConfig,
    input: H3DirectorConfig,
    callbacks: { onMedia: (stream: MediaStream) => void; onPhase: (phase: H3DirectorPhase) => void; onMessage?: (message: Record<string, unknown>) => void; onError?: (error: Error) => void },
    signal?: AbortSignal,
): Promise<H3DirectorConnection> {
    const proxy = buildApiUrl(config.baseUrl, "/h3/director/proxy");
    // All three bridge requests travel through the authenticated server boundary.
    // No fal key is present in the browser and session POSTs never auto-retry.
    const client = createFalClient({
        credentials: "",
        retry: { maxRetries: 0 },
        requestMiddleware: async (request) => {
            const target = new URL(request.url);
            if (target.origin !== "https://wma.fal.run" || !["/ice", "/session", "/session/heartbeat"].includes(target.pathname) || request.method !== "POST") throw new Error("导演请求地址不受支持");
            const routed = channelRequest(config, proxy, { "Content-Type": "application/json", "x-fal-target-url": target.href });
            return { ...request, url: routed.url, headers: routed.headers };
        },
        fetch: async (url, init) => fetch(url, { ...init, credentials: "include" }),
    });
    let live: ReturnType<typeof client.realtime.open<ReturnType<typeof wma>>> | undefined;
    const control = new H3DirectorControl((message) => live?.send(message), callbacks.onPhase);
    live = client.realtime.open(wma("minimax/h3-max/director"), {
        receive: ["video", "audio"],
        abortSignal: signal,
        negotiationTimeoutMs: 60_000,
        onMedia: callbacks.onMedia,
        onData: (raw) => {
            if (raw.length > 256 * 1024) return;
            let message: Record<string, unknown>;
            try {
                message = JSON.parse(raw);
            } catch {
                return;
            }
            if (!message || typeof message !== "object" || Array.isArray(message)) return;
            control.accept(message);
            callbacks.onMessage?.(message);
            if (message.type === "stream_exhausted" || message.type === "error") void live?.close();
        },
        onError: (error) => {
            control.fail();
            callbacks.onError?.(new Error(error instanceof Error ? error.message : "导演会话连接失败"));
        },
        onState: (state) => {
            if (state === "failed") control.fail();
            else if (state === "closed") control.close();
        },
    });
    try {
        await live.ready;
        control.configure(input);
    } catch (error) {
        await live.close();
        throw error;
    }
    return {
        control,
        update: (value) => control.update(value),
        stop: async () => {
            control.stop();
            await live?.close();
            control.close();
        },
    };
}

export function recordH3Director(stream: MediaStream): { stop: () => Promise<Blob> } {
    if (!stream.getVideoTracks().length || !stream.getAudioTracks().length) throw new Error("导演视频和音频尚未就绪");
    const mime = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find((v) => MediaRecorder.isTypeSupported(v));
    if (!mime) throw new Error("当前客户端不支持录制导演视频");
    const recorder = new MediaRecorder(stream, { mimeType: mime }),
        parts: BlobPart[] = [];
    let bytes = 0;
    let error: Error | undefined;
    const finished = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (e) => {
            if (e.data.size) {
                bytes += e.data.size;
                if (bytes > 256 * 1024 * 1024) {
                    error = new Error("录制视频超过 256 MB，请缩短会话");
                    recorder.stop();
                    return;
                }
                parts.push(e.data);
            }
        };
        recorder.onerror = () => {
            error = new Error("导演视频录制失败");
        };
        recorder.onstop = () => {
            if (error) reject(error);
            else {
                const blob = new Blob(parts, { type: mime });
                if (!blob.size) reject(new Error("导演录制没有收到视频数据"));
                else resolve(blob);
            }
        };
    });
    // Attach a handler immediately so a recorder failure never becomes an
    // unhandled rejection while the user is still directing the stream.
    void finished.catch(() => {});
    recorder.start(1000);
    return {
        stop: () => {
            if (recorder.state !== "inactive") recorder.stop();
            return finished;
        },
    };
}
