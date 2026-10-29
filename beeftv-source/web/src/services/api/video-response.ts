import axios from "axios";

import { explainGenerationError } from "@/lib/generation-error";
import { assertChannelBlob, assertChannelPayload, ChannelResponseError, normalizeChannelFailure } from "@/services/api/channel-transport";
import type { ApiEnvelope, ApiVideoResponse, RequestOptions, SeedanceTask, VideoGenerationResult } from "./video-contracts";

export function videoTaskId(payload: { id?: string; request_id?: string; task_id?: string }) {
    return payload.id || payload.request_id || payload.task_id || "";
}

export function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

export function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

export function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    assertChannelPayload(payload);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

export function readAxiosError(error: unknown, fallback: string) {
    if (error instanceof ChannelResponseError) throw error;
    if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
    if (axios.isAxiosError(error)) {
        return explainGenerationError({
            message: fallback,
            status: error.response?.status,
            data: error.response?.data ?? error.message,
        }).message;
    }
    return explainGenerationError(error).message || fallback;
}

export function statusMessage(status: number | undefined, fallback: string) {
    return explainGenerationError({ message: fallback, status }).message || fallback;
}

export async function assertVideoBlob(blob: Blob) {
    await assertChannelBlob(blob);
}

export function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

export function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地素材失败"));
        reader.readAsDataURL(blob);
    });
}

export async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (error instanceof ChannelResponseError) throw error;
        if (axios.isAxiosError(error) && error.response) return normalizeChannelFailure(error);
        return { url, mimeType: "video/mp4" };
    }
}

export type VideoResponseTools = {
    assertVideoBlob: typeof assertVideoBlob;
    blobToDataUrl: typeof blobToDataUrl;
    delay: typeof delay;
    readAxiosError: typeof readAxiosError;
    unwrapEnvelope: typeof unwrapEnvelope;
    unwrapEnvelopeRecord: typeof unwrapEnvelopeRecord;
    unwrapSeedanceTask: typeof unwrapSeedanceTask;
    unwrapVideoResponse: typeof unwrapVideoResponse;
    videoResultFromUrl: typeof videoResultFromUrl;
    videoTaskId: typeof videoTaskId;
};

function unwrapEnvelopeRecord(value: ApiEnvelope<Record<string, unknown>>): Record<string, unknown> {
    assertChannelPayload(value);
    if (value && typeof value === "object" && "data" in value && value.data && typeof value.data === "object") return value.data as Record<string, unknown>;
    return value as Record<string, unknown>;
}

export const videoResponseTools: VideoResponseTools = {
    assertVideoBlob,
    blobToDataUrl,
    delay,
    readAxiosError,
    unwrapEnvelope,
    unwrapEnvelopeRecord,
    unwrapSeedanceTask,
    unwrapVideoResponse,
    videoResultFromUrl,
    videoTaskId,
};
