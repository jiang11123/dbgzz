import { type AxiosError, type AxiosRequestConfig } from "axios";

import { appPathnameFrom } from "@/lib/app-routing";
import { apiClient } from "@/services/api/request";
import { browserCapabilities } from "./browser-environment";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { createDiagnosticEventStore } from "./diagnostic-event-store";
import { createDiagnosticTrace, diagnosticTraceHeaders, parseDiagnosticTraceparent, validTraceId } from "./diagnostic-trace";
export type { ClientDiagnosticCoverage } from "./diagnostic-event-store";

export type ClientDiagnosticLevel = "info" | "warning" | "error";
export type ClientDiagnosticCategory = "navigation" | "action" | "request" | "runtime" | "task" | "plugin" | "environment";

export type CanvasBindingEvidence = {
    source: "client" | "server";
    nodeId?: string;
    clientOperationId?: string;
    nodeTaskId?: string;
    nodeClientOperationId?: string;
    nodeType?: string;
    nodeStatus?: string;
    revision?: number;
    outputIndex?: number;
    nodePresent?: boolean;
    nodeHasMedia?: boolean;
};

export type ClientDiagnosticEvent = {
    canvasBinding?: CanvasBindingEvidence;
    id: string;
    timestamp: string;
    level: ClientDiagnosticLevel;
    category: ClientDiagnosticCategory;
    code?: string;
    reason?: string;
    message: string;
    route?: string;
    durationMs?: number;
    httpStatus?: number;
    requestId?: string;
    traceId?: string;
    taskId?: string;
    projectId?: string;
    canvasId?: string;
    launchId?: string;
    sessionId?: string;
    spanId?: string;
    clientOperationId?: string;
    nodeId?: string;
    assistantSessionId?: string;
    assistantTurnId?: string;
    media?: { phase: string; readyState?: number; networkState?: number; errorCode?: number; width?: number; height?: number };
    stack?: string;
};

type DiagnosticEventInput = Omit<ClientDiagnosticEvent, "id" | "timestamp"> & { timestamp?: string };
type RequestDiagnosticMeta = { startedAt: number; traceId: string; spanId: string; epoch: number; context: Partial<ClientDiagnosticEvent> };

const requestMeta = new WeakMap<object, RequestDiagnosticMeta>();
const taskTraces = new Map<string, string>();
let initialized = false;
let scopedUserId = getActiveUserScope();
let scopeEpoch = 0;
const launchId = createDiagnosticId("launch");
const eventStore = createDiagnosticEventStore({ storage: scope => localForageStorageForScope(scope), sanitize: sanitizeEvent, launchId });
eventStore.setScope(scopedUserId);

export function initializeClientDiagnostics() {
    if (initialized || typeof window === "undefined") return;
    initialized = true;
    window.addEventListener("error", (event) => {
        recordDiagnosticEvent({
            level: "error",
            category: "runtime",
            message: event.message || "页面运行异常",
            stack: event.error instanceof Error ? event.error.stack : undefined,
        });
    });
    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || "未处理的 Promise 异常"));
        recordDiagnosticEvent({ level: "error", category: "runtime", message: reason.message, stack: reason.stack });
    });

    apiClient.interceptors.request.use(
        (config) => {
            const route = appPathnameFrom(config.url);
            const context = requestContext(config);
            const explicit = parseDiagnosticTraceparent(readHeader(config.headers, "traceparent"));
            const trace = explicit ?? createDiagnosticTrace(readHeader(config.headers, "x-canvas-trace-id") || getDiagnosticTraceId(context.taskId));
            for (const [name, value] of Object.entries(diagnosticTraceHeaders(trace))) setHeader(config, name, value);
            requestMeta.set(config, { startedAt: performance.now(), ...trace, epoch: scopeEpoch, context });
            if (!isDiagnosticRoute(route) && config.method?.toLowerCase() !== "get") recordDiagnosticEvent({ level: "info", category: "request", code: "request_started", message: `${String(config.method).toUpperCase()} ${route}`, route, ...trace, ...context });
            return config;
        },
        (error) => {
            recordDiagnosticEvent({ level: "error", category: "request", message: "请求发送前失败" });
            return Promise.reject(error);
        },
    );
    apiClient.interceptors.response.use(
        (response) => {
            const config = response.config;
            const meta = requestMeta.get(config);
            const route = appPathnameFrom(config.url);
            if (isDiagnosticRoute(route) || (meta && meta.epoch !== scopeEpoch)) return response;
            const status = response.status;
            const businessCode = response.data && typeof response.data === "object" && "code" in response.data ? Number(response.data.code) : 0;
            const requestId = readHeader(response.headers, "x-request-id");
            const payload = response.data?.data;
            const taskId = route.startsWith("/tasks") && typeof payload?.id === "string" ? payload.id : meta?.context.taskId;
            const traceId = [readHeader(response.headers, "x-canvas-trace-id"), payload?.traceId, meta?.traceId].find(validTraceId);
            if (taskId && traceId) {
                taskTraces.set(taskId, traceId);
                if (taskTraces.size > 1000) taskTraces.delete(taskTraces.keys().next().value!);
            }
            recordDiagnosticEvent({
                level: status >= 400 || businessCode !== 0 ? "error" : "info",
                category: "request",
                code: businessCode !== 0 ? String(businessCode) : undefined,
                reason: response.data?.reason,
                message: String(config.method || "GET").toUpperCase() + " " + route,
                route,
                durationMs: meta ? Math.max(0, Math.round(performance.now() - meta.startedAt)) : undefined,
                httpStatus: status,
                requestId,
                ...meta?.context,
                taskId,
                canvasId: meta?.context.canvasId || safeDiagnosticId(payload?.projectId),
                nodeId: meta?.context.nodeId || safeDiagnosticId(payload?.clientContext?.nodeId),
                clientOperationId: meta?.context.clientOperationId || safeOperationId(payload?.clientOperationId),
                traceId,
                spanId: meta?.spanId,
            });
            return response;
        },
        (error: AxiosError) => {
            const config = error.config;
            const meta = config ? requestMeta.get(config) : undefined;
            const response = error.response;
            const body = response?.data && typeof response.data === "object" ? (response.data as { code?: number; msg?: string; reason?: string }) : undefined;
            const route = appPathnameFrom(config?.url);
            if (isDiagnosticRoute(route) || (meta && meta.epoch !== scopeEpoch)) return Promise.reject(error);
            recordDiagnosticEvent({
                level: "error",
                category: "request",
                code: body?.code !== undefined ? String(body.code) : response?.status ? "HTTP_" + response.status : "NETWORK_ERROR",
                reason: body?.reason,
                message: body?.msg || String(config?.method || "GET").toUpperCase() + " " + route + " 请求失败",
                route,
                durationMs: meta ? Math.max(0, Math.round(performance.now() - meta.startedAt)) : undefined,
                httpStatus: response?.status,
                requestId: response ? readHeader(response.headers, "x-request-id") : undefined,
                ...meta?.context,
                traceId: response ? readHeader(response.headers, "x-canvas-trace-id") || meta?.traceId : meta?.traceId,
                spanId: meta?.spanId,
            });
            return Promise.reject(error);
        },
    );
}

export function setDiagnosticUserScope(userId: string) {
    const next = userId.trim() || "guest";
    if (next === scopedUserId) return;
    scopedUserId = next;
    scopeEpoch += 1;
    taskTraces.clear();
    eventStore.setScope(next);
}

export function recordDiagnosticEvent(input: DiagnosticEventInput) {
    eventStore.record(sanitizeEvent({ ...input, id: createDiagnosticId("event"), timestamp: input.timestamp || new Date().toISOString(), launchId, sessionId: launchId }));
}

function sanitizeEvent(input: ClientDiagnosticEvent): ClientDiagnosticEvent {
    const event: ClientDiagnosticEvent = {
        id: safeDiagnosticId(input.id) || createDiagnosticId("event"),
        timestamp: input.timestamp,
        level: ["info", "warning", "error"].includes(input.level) ? input.level : "warning",
        category: ["navigation", "action", "request", "runtime", "task", "plugin", "environment"].includes(input.category) ? input.category : "runtime",
        code: redactClientText(input.code),
        reason: safeDiagnosticId(input.reason),
        message: redactClientText(input.message) || "未命名诊断事件",
        route: appPathnameFrom(input.route),
        durationMs: input.durationMs === undefined ? undefined : clampNumber(input.durationMs, 0, 86_400_000),
        httpStatus: input.httpStatus === undefined ? undefined : clampNumber(input.httpStatus, 0, 599),
        requestId: safeDiagnosticId(input.requestId),
        traceId: validTraceId(input.traceId) ? input.traceId : undefined,
        taskId: safeDiagnosticId(input.taskId),
        projectId: safeDiagnosticId(input.projectId),
        canvasId: safeDiagnosticId(input.canvasId),
        launchId: safeDiagnosticId(input.launchId), sessionId: safeDiagnosticId(input.sessionId),
        spanId: typeof input.spanId === "string" && /^[a-f0-9]{16}$/i.test(input.spanId) ? input.spanId : undefined,
        clientOperationId: safeOperationId(input.clientOperationId), nodeId: safeDiagnosticId(input.nodeId),
        assistantSessionId: safeDiagnosticId(input.assistantSessionId), assistantTurnId: safeDiagnosticId(input.assistantTurnId),
        media: input.media && safeDiagnosticId(input.media.phase) ? { phase: input.media.phase, ...Object.fromEntries(["readyState", "networkState", "errorCode", "width", "height"].flatMap(key => { const value = input.media?.[key as keyof typeof input.media]; return typeof value === "number" ? [[key, clampNumber(value, 0, 65536)]] : []; })) } : undefined,
        canvasBinding: sanitizeCanvasBindingEvidence(input.canvasBinding),
        stack: redactClientText(input.stack, 4000),
    };
    return event;
}

export function getClientDiagnosticEvents(range?: { from?: Date; to?: Date }) {
    return eventStore.events(range);
}

export const getClientDiagnosticSnapshot = (range?: { from?: Date; to?: Date }) => eventStore.snapshot(range);

export function getDiagnosticRuntime() {
    return {
        appVersion: String(import.meta.env.VITE_APP_VERSION || "dev"),
        buildCommit: String(import.meta.env.VITE_BUILD_COMMIT || "unknown"),
        browser: typeof navigator !== "undefined" ? navigator.userAgent : "",
        os: typeof navigator !== "undefined" ? navigator.platform : "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        capabilities: browserCapabilities(),
    };
}

export function getDiagnosticTraceId(taskId?: string) {
    if (!taskId) return undefined;
    const trace = taskTraces.get(taskId) || getClientDiagnosticEvents().reverse().find(event => event.taskId === taskId && validTraceId(event.traceId))?.traceId;
    if (trace) taskTraces.set(taskId, trace);
    return trace;
}

export function taskDiagnosticHeaders(taskId: string, traceId?: string) {
    return diagnosticTraceHeaders(createDiagnosticTrace(traceId || getDiagnosticTraceId(taskId)));
}

function setHeader(config: AxiosRequestConfig, name: string, value: string) {
    if (!config.headers) config.headers = {};
    if (typeof config.headers.set === "function") config.headers.set(name, value);
    else config.headers[name] = value;
}

function readHeader(headers: unknown, key: string) {
    if (!headers || typeof headers !== "object") return undefined;
    const candidate = headers as { get?: (name: string) => string | null; [name: string]: unknown };
    if (typeof candidate.get === "function") { const value = candidate.get(key); return typeof value === "string" ? value : undefined; }
    const value = candidate[key] ?? candidate[key.toLowerCase()] ?? Object.entries(candidate).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    return typeof value === "string" ? value : undefined;
}

export function safeDiagnosticId(value?: string) {
    const normalized = String(value || "").trim();
    return /^[A-Za-z0-9._:-]{1,96}$/.test(normalized) && !/^(?:sk-|eyJ)|bearer|password|api[_-]?key|secret|token/i.test(normalized) ? normalized : undefined;
}

function safeOperationId(value?: string) { return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value) && !/^(?:sk-|eyJ)|bearer|password|api[_-]?key|secret|token/i.test(value) ? value : undefined; }

function isDiagnosticRoute(route: string) { return route.startsWith("/diagnostics"); }

function requestContext(config: AxiosRequestConfig): Partial<ClientDiagnosticEvent> {
    const route = appPathnameFrom(config.url);
    let body = config.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = undefined; } }
    const params = body?.params ?? body;
    const pathTaskId = route.match(/^\/tasks\/([^/]+)(?:\/|$)/)?.[1];
    return { taskId: safeDiagnosticId((pathTaskId !== "by-operation" ? pathTaskId : undefined) || params?.taskId), canvasId: safeDiagnosticId(params?.canvasId || params?.projectId || config.params?.canvasId), projectId: safeDiagnosticId(params?.projectId), nodeId: safeDiagnosticId(params?.nodeId || body?.input?.nodeId || body?.input?.clientContext?.nodeId), clientOperationId: safeOperationId(body?.opId || body?.clientOperationId || body?.input?.clientOperationId), assistantSessionId: safeDiagnosticId(params?.sessionId || config.params?.sessionId), assistantTurnId: safeDiagnosticId(params?.turnId || route.match(/^\/assistant\/turns\/([^/]+)/)?.[1]) };
}

export function sanitizeCanvasBindingEvidence(value: unknown): CanvasBindingEvidence | undefined {
    if (!value || typeof value !== "object") return undefined;
    const input = value as Record<string, unknown>;
    if (input.source !== "client" && input.source !== "server") return undefined;
    const operationId = (value: unknown) => typeof value === "string" ? safeOperationId(value) : undefined;
    const id = (value: unknown) => typeof value === "string" ? safeDiagnosticId(value) : undefined;
    return {
        source: input.source, nodeId: id(input.nodeId), nodeTaskId: id(input.nodeTaskId),
        clientOperationId: operationId(input.clientOperationId), nodeClientOperationId: operationId(input.nodeClientOperationId),
        nodeType: id(input.nodeType), nodeStatus: id(input.nodeStatus),
        revision: typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : undefined,
        outputIndex: typeof input.outputIndex === "number" ? clampNumber(input.outputIndex, 0, 999) : undefined,
        nodePresent: typeof input.nodePresent === "boolean" ? input.nodePresent : undefined,
        nodeHasMedia: typeof input.nodeHasMedia === "boolean" ? input.nodeHasMedia : undefined,
    };
}

function redactClientText(value?: string, maxLength = 1200) {
    let text = String(value || "").trim();
    if (!text) return "";
    if (/^[{[<]/.test(text)) return "[STRUCTURED_BODY_REDACTED]";
    text = text.replace(/["']?(authorization|cookie|set-cookie|api[_-]?key|secret[_-]?key|password|token|prompt|input|query)["']?\s*[:=：][\s\S]*/gi, "$1=[REDACTED]");
    text = text.replace(/\bBearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]+)*/gi, "[SECRET_REDACTED]");
    text = text.replace(/(?:https?:\/\/|blob:|data:)[^\s"'<>]+/gi, "[URL_REDACTED]");
    text = text.replace(/(?:[a-z]:[\\/]|\/(?:Users|home|private|tmp|var|Volumes|mnt|media|root|etc)\/)[^\r\n:"'<>]+/gi, "[PATH_REDACTED]");
    return text.slice(0, maxLength);
}

function clampNumber(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
}

function createDiagnosticId(prefix: string) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return prefix + "-" + crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}
