export type DiagnosticTraceContext = { traceId: string; spanId: string; traceFlags: string };

export function validTraceId(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value) && !/^0+$/.test(value);
}

function randomHex(bytes: number) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return Array.from(data, n => n.toString(16).padStart(2, "0")).join("");
}

export function createDiagnosticTrace(traceId?: string): DiagnosticTraceContext {
    return { traceId: validTraceId(traceId) ? traceId.toLowerCase() : randomHex(16), spanId: randomHex(8), traceFlags: "01" };
}

export function parseDiagnosticTraceparent(value?: string): DiagnosticTraceContext | undefined {
    const match = value?.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/i);
    if (!match || !validTraceId(match[1]) || /^0+$/.test(match[2])) return undefined;
    return { traceId: match[1].toLowerCase(), spanId: match[2].toLowerCase(), traceFlags: match[3].toLowerCase() };
}

export function diagnosticTraceHeaders(trace: DiagnosticTraceContext) {
    return { traceparent: `00-${trace.traceId}-${trace.spanId}-${trace.traceFlags}`, "X-Canvas-Trace-ID": trace.traceId };
}
