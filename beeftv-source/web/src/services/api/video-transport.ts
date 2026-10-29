import { createChannelTransport } from "@/services/api/channel-transport";
import { buildApiUrl } from "@/stores/use-config-store";

import type { RequestOptions, ResolvedAiConfig } from "./video-contracts";

export type VideoTransport = {
    apiUrl: (path: string) => string;
    post: <T>(upstreamUrl: string, body: unknown, options?: RequestOptions) => Promise<T>;
    postForm: <T>(upstreamUrl: string, body: FormData, options?: RequestOptions) => Promise<T>;
    get: <T>(upstreamUrl: string, options?: RequestOptions) => Promise<T>;
    getBlob: (upstreamUrl: string, options?: RequestOptions) => Promise<Blob>;
    getExternalBlob: (url: string, headers: Record<string, string>, options?: RequestOptions) => Promise<Blob>;
};

/**
 * 统一视频 Provider 的 HTTP 边界。Provider 只负责协议和 payload，不再重复拼接中转请求。
 */
export function createVideoTransport(config: ResolvedAiConfig): VideoTransport {
    const transport = createChannelTransport(config, "video");
    return {
        apiUrl: (path) => buildApiUrl(config.baseUrl, path),
        post: (upstreamUrl, body, options) => transport.postJson(upstreamUrl, body, options),
        postForm: (upstreamUrl, body, options) => transport.postForm(upstreamUrl, body, options),
        get: (upstreamUrl, options) => transport.get(upstreamUrl, options),
        getBlob: (upstreamUrl, options) => transport.getBlob(upstreamUrl, options),
        getExternalBlob: (url, headers, options) => transport.getExternalBlob(url, headers, options),
    };
}
