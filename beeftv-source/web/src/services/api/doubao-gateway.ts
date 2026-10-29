/**
 * 豆包工作站本地网关客户端（豆包 3.0 扩展）。
 *
 * 网关由豆包工作站在后台隐身运行，默认监听 http://127.0.0.1:8788，
 * 对回环请求免鉴权并开放 CORS，因此浏览器可直接 fetch。
 * 契约见工作站仓库 DOUBAO_3.0_SPEC.md §4。
 */

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8788";
const GATEWAY_URL_STORAGE_KEY = "dbgzz:gatewayBaseUrl";

export function doubaoGatewayBaseUrl(): string {
    const fromEnv = import.meta.env.VITE_DOUBAO_GATEWAY_URL as string | undefined;
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
    try {
        const stored = window.localStorage.getItem(GATEWAY_URL_STORAGE_KEY);
        if (stored) return stored.replace(/\/+$/, "");
    } catch {
        // localStorage 不可用时静默回退默认值
    }
    return DEFAULT_GATEWAY_URL;
}

export type DoubaoGatewayAccount = {
    id: number;
    name: string;
    avatar?: string;
    status: string;
    quota: string;
    isLoggedIn?: boolean;
    available?: boolean;
    busy?: boolean;
};

export type DoubaoVideoTaskState = {
    task_id: string;
    status: "queued" | "processing" | "awaiting_confirmation" | "completed" | "needs_attention" | "failed" | "cancelled" | string;
    progress: number;
    video_url?: string | null;
    local_path?: string | null;
    last_frame_path?: string | null;
    status_text?: string;
    /** 豆包最新回复原文；awaiting_confirmation 时是待用户确认的问题内容。 */
    latest_reply?: string | null;
    error?: string | null;
};

export class DoubaoGatewayError extends Error {
    constructor(message: string, readonly statusCode?: number) {
        super(message);
        this.name = "DoubaoGatewayError";
    }
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(`${doubaoGatewayBaseUrl()}${path}`, init);
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new DoubaoGatewayError("网关请求超时，请确认豆包工作站正在运行", 0);
        }
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new DoubaoGatewayError("请求已取消", 0);
        }
        throw new DoubaoGatewayError("无法连接豆包工作站网关，请确认豆包工作站已在后台运行", 0);
    }
    return response;
}

async function gatewayJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await gatewayFetch(path, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = (payload as { error?: { message?: string } } | null)?.error?.message || `网关请求失败（HTTP ${response.status}）`;
        throw new DoubaoGatewayError(message, response.status);
    }
    // 网关异常页（HTML/空 body）也会 HTTP 200，这里兜底成可读错误而不是下游 TypeError。
    if (payload === null || typeof payload !== "object") {
        throw new DoubaoGatewayError(`网关返回了无法解析的响应（HTTP ${response.status}）`, response.status);
    }
    return payload as T;
}

/** 组件级取消信号 + 单次请求超时的组合；AbortSignal.any 不可用时退化为仅组件取消。 */
export function gatewaySignal(controller: AbortController, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
        return AbortSignal.any([controller.signal, timeout]);
    } catch {
        return controller.signal;
    }
}

export async function fetchDoubaoAccounts(signal?: AbortSignal): Promise<DoubaoGatewayAccount[]> {
    const payload = await gatewayJson<{ accounts?: DoubaoGatewayAccount[] }>("/v1/doubao/accounts", { signal });
    return payload.accounts ?? [];
}

export async function requestAddDoubaoAccount(): Promise<void> {
    await gatewayJson("/v1/accounts/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

/** 复用桌面端的确认、忙碌校验与账号清理流程。取消时返回 false。 */
export async function confirmDeleteDoubaoAccount(accountId: number): Promise<boolean> {
    const workspace = (window as Window & { workspace?: { confirmDeleteAccount?: (id: number) => Promise<boolean> } }).workspace;
    if (!workspace?.confirmDeleteAccount) throw new DoubaoGatewayError("请在豆包工作站桌面应用中删除账号");
    return workspace.confirmDeleteAccount(accountId);
}

export async function doubaoChatCompletion(accountId: number, prompt: string, deepThink = false, signal?: AbortSignal): Promise<string> {
    const payload = await gatewayJson<{ choices?: Array<{ message?: { content?: string } }> }>("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: deepThink ? `doubao-think-account-${accountId}` : `doubao-account-${accountId}`,
            messages: [{ role: "user", content: prompt }],
            stream: false,
        }),
        signal,
    });
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new DoubaoGatewayError("豆包账号没有返回对话内容");
    return content;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
}

/** 生图：请求 b64_json，服务端代下载避免浏览器跨域抓取豆包 CDN。支持传入 referenceDataUrls 参考图片（图生图/垫图）。 */
export async function doubaoGenerateImage(accountId: number, prompt: string, options?: { ratio?: string; referenceDataUrls?: string[]; signal?: AbortSignal }): Promise<{ blob: Blob; mimeType: string }> {
    const payload = await gatewayJson<{ data?: Array<{ b64_json?: string; mime?: string }> }>("/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: `doubao-image-account-${accountId}`,
            prompt,
            response_format: "b64_json",
            size: options?.ratio,
            image_urls: options?.referenceDataUrls?.length ? options.referenceDataUrls : undefined,
        }),
        signal: options?.signal,
    });
    const item = payload.data?.[0];
    if (!item?.b64_json) throw new DoubaoGatewayError("豆包账号没有返回生成图片");
    const mimeType = item.mime || "image/png";
    return { blob: base64ToBlob(item.b64_json, mimeType), mimeType };
}

export async function doubaoSubmitVideoTask(accountId: number, prompt: string, options?: { ratio?: string; duration?: number; videoModel?: string; referenceDataUrls?: string[] }): Promise<string> {
    const payload = await gatewayJson<{ task_id?: string }>("/v1/video/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: `doubao-video-account-${accountId}`,
            video_model: options?.videoModel,
            prompt,
            ratio: options?.ratio,
            duration: options?.duration,
            image_urls: options?.referenceDataUrls?.length ? options.referenceDataUrls : undefined,
        }),
    });
    if (!payload.task_id) throw new DoubaoGatewayError("网关没有返回视频任务 ID");
    return payload.task_id;
}

export async function doubaoPollVideoTask(taskId: string, signal?: AbortSignal): Promise<DoubaoVideoTaskState> {
    return gatewayJson<DoubaoVideoTaskState>(`/v1/video/tasks/${encodeURIComponent(taskId)}`, { signal });
}

export async function doubaoCancelVideoTask(taskId: string): Promise<void> {
    await gatewayJson(`/v1/video/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
}

/** 豆包生成前要求确认参数/补充材料时，把用户输入作为补充消息发回执行账号页面。 */
export async function doubaoConfirmVideoTask(taskId: string, text: string): Promise<void> {
    await gatewayJson(`/v1/video/tasks/${encodeURIComponent(taskId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
}

async function fetchTaskBlob(taskId: string, action: "video" | "last_frame", fallbackMime: string, signal?: AbortSignal): Promise<Blob> {
    const response = await gatewayFetch(`/v1/video/tasks/${encodeURIComponent(taskId)}/${action}`, { signal });
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new DoubaoGatewayError((payload as { error?: { message?: string } } | null)?.error?.message || `下载视频${action === "video" ? "" : "尾帧"}失败（HTTP ${response.status}）`, response.status);
    }
    return new Blob([await response.arrayBuffer()], { type: response.headers.get("content-type") || fallbackMime });
}

export async function doubaoFetchTaskVideo(taskId: string, signal?: AbortSignal): Promise<Blob> {
    return fetchTaskBlob(taskId, "video", "video/mp4", signal);
}

export async function doubaoFetchTaskLastFrame(taskId: string, signal?: AbortSignal): Promise<Blob> {
    return fetchTaskBlob(taskId, "last_frame", "image/png", signal);
}
