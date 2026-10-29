import axios from "axios";

import { createClientId } from "@/lib/client-id";
import { explainGenerationError } from "@/lib/generation-error";
import { channelRequest } from "@/services/api/custom-channel-relay";
import { isSystemProxyBaseUrl } from "@/stores/use-config-store";

export type ChannelScene = "image" | "video" | "audio";

const ERROR_BODY_LIMIT = 16 * 1024;

// Keep only normalized, sanitized diagnostic fields, never Axios config/headers.
export class ChannelResponseError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly requestId?: string;
    readonly data: { error: { code: string; message: string }; request_id?: string };

    constructor(payload: unknown, status?: number) {
        const explanation = explainGenerationError(status ? { status, data: payload } : payload);
        super(explanation.message);
        this.name = "ChannelResponseError";
        this.code = explanation.providerCode || explanation.errorCode;
        this.status = status;
        this.requestId = explanation.requestId;
        this.data = { error: { code: this.code, message: this.message }, request_id: this.requestId };
    }
}

function hasBusinessFailure(value: unknown, depth = 0): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return false;
    const record = value as Record<string, unknown>;
    if (record.error && (typeof record.error === "string" || typeof record.error === "object")) return true;
    if (record.success === false) return true;
    if (typeof record.code === "number" && record.code !== 0 && record.code !== 200) return true;
    if (typeof record.code === "string" && record.code.trim() && !["0", "200", "ok", "success", "succeeded"].includes(record.code.toLowerCase())) return true;
    return ["data", "result", "output"].some((key) => hasBusinessFailure(record[key], depth + 1));
}

export function assertChannelPayload(payload: unknown, status?: number): void {
    if (hasBusinessFailure(payload)) throw new ChannelResponseError(payload, status);
}

async function boundedBlobPayload(blob: Blob): Promise<unknown> {
    const text = await blob.slice(0, ERROR_BODY_LIMIT).text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

// JSON/HTML cannot be a successful media artifact, even with HTTP 200.
export async function assertChannelBlob(blob: Blob): Promise<void> {
    const mime = blob.type.toLowerCase();
    if (/^(?:image|video|audio)\//.test(mime)) return;
    const prefix = (await blob.slice(0, 256).text()).trimStart();
    if (!/json|^text\//.test(mime) && !/^[{[]|^<(?:!doctype|html|head|body)/i.test(prefix)) return;
    const payload = await boundedBlobPayload(blob);
    assertChannelPayload(payload);
    throw new ChannelResponseError({ code: "malformed_response", message: "模型服务返回了无法解析的内容" });
}

export function isChannelCancellation(error: unknown): boolean {
    return axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError");
}

export async function normalizeChannelFailure(error: unknown): Promise<never> {
    if (isChannelCancellation(error)) throw error;
    if (!axios.isAxiosError(error)) throw error;
    const data = error.response?.data;
    const payload = data instanceof Blob ? await boundedBlobPayload(data) : (data ?? error.message);
    throw new ChannelResponseError(payload, error.response?.status);
}

async function channelResponse<T>(request: Promise<{ data: T; status: number }>, acceptEventStream = false): Promise<T> {
    try {
        const response = await request;
        if (response.data instanceof Blob) {
            if (!(acceptEventStream && response.data.type.startsWith("text/event-stream"))) await assertChannelBlob(response.data);
        }
        else assertChannelPayload(response.data, response.status);
        return response.data;
    } catch (error) {
        return normalizeChannelFailure(error);
    }
}

export type ChannelTransportConfig = Parameters<typeof channelRequest>[0] & {
    apiKey?: string;
    baseUrl?: string;
    credentialRef?: string;
};

export type ChannelCallOptions = {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    acceptEventStream?: boolean;
};

export type ChannelTransport = {
    postJson: <T>(upstreamUrl: string, body: unknown, options?: ChannelCallOptions) => Promise<T>;
    postBlob: (upstreamUrl: string, body: unknown, options?: ChannelCallOptions) => Promise<Blob>;
    postForm: <T>(upstreamUrl: string, body: FormData, options?: ChannelCallOptions) => Promise<T>;
    get: <T>(upstreamUrl: string, options?: ChannelCallOptions) => Promise<T>;
    getBlob: (upstreamUrl: string, options?: ChannelCallOptions) => Promise<Blob>;
    getExternalBlob: (url: string, headers?: Record<string, string>, options?: ChannelCallOptions) => Promise<Blob>;
};

/**
 * 自定义渠道的唯一 HTTP 边界。image / video / audio 只组协议 payload，不再各自 axios + channelRequest。
 */
export function createChannelTransport(config: ChannelTransportConfig, scene?: ChannelScene): ChannelTransport {
    const sceneHeaders = (contentType?: string, extra?: Record<string, string>) => ({
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(scene && config.baseUrl && isSystemProxyBaseUrl(config.baseUrl) ? { "X-Canvas-Scene": scene, "X-Idempotency-Key": createClientId() } : {}),
        ...extra,
    });

    const send = async <T>(method: "get" | "post", upstreamUrl: string, body: unknown, options?: ChannelCallOptions & { contentType?: string; responseType?: "blob" }) => {
        const request = channelRequest(config, upstreamUrl, sceneHeaders(options?.contentType, options?.headers));
        return channelResponse(
            axios.request<T>({
                method,
                url: request.url,
                data: method === "get" ? undefined : body,
                headers: request.headers,
                withCredentials: request.credentials === "include",
                signal: options?.signal,
                responseType: options?.responseType,
            }), options?.acceptEventStream,
        );
    };

    return {
        postJson: (upstreamUrl, body, options) => send("post", upstreamUrl, body, { ...options, contentType: "application/json" }),
        postBlob: (upstreamUrl, body, options) => send("post", upstreamUrl, body, { ...options, contentType: "application/json", responseType: "blob" }),
        postForm: (upstreamUrl, body, options) => send("post", upstreamUrl, body, options),
        get: (upstreamUrl, options) => send("get", upstreamUrl, undefined, options),
        getBlob: (upstreamUrl, options) => send("get", upstreamUrl, undefined, { ...options, responseType: "blob" }),
        getExternalBlob: (url, headers, options) => channelResponse(axios.get<Blob>(url, { headers, responseType: "blob", signal: options?.signal })),
    };
}
