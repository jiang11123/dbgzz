export type SupportDiagnosticContext = {
    traceId?: string;
    clientOperationId?: string;
    canvasId?: string;
    nodeId?: string;
    assistantSessionId?: string;
    assistantTurnId?: string;
};

export function supportDiagnosticIdentity(context: SupportDiagnosticContext, options: { appVersion?: string; buildCommit?: string; capturedAt?: string; kind?: "generation" | "assistant" } = {}) {
    const safe = (value?: string) => value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^(?:sk-|eyJ)|bearer|password|secret/i.test(value) ? value : undefined;
    const traceId = context.traceId && /^[a-f0-9]{32}$/i.test(context.traceId) && !/^0+$/.test(context.traceId) ? context.traceId : undefined;
    const fields = options.kind === "assistant" ? [["Trace ID", traceId], ["画布 ID", context.canvasId], ["助手会话 ID", context.assistantSessionId], ["助手轮次 ID", context.assistantTurnId]] : [["Trace ID", traceId], ["操作 ID", context.clientOperationId], ["画布 ID", context.canvasId], ["节点 ID", context.nodeId]];
    const missing = fields.filter(([, value]) => !safe(value)).map(([label]) => label);
    return [
        `应用版本：${safe(options.appVersion) || "未记录"}`,
        `构建提交：${safe(options.buildCommit) || "未记录"}`,
        `排查信息生成时间：${options.capturedAt && Number.isFinite(Date.parse(options.capturedAt)) ? new Date(options.capturedAt).toISOString() : new Date().toISOString()}`,
        ...fields.flatMap(([label, value]) => safe(value) ? [`${label}：${safe(value)}`] : []),
        missing.length ? `关联证据未记录：${missing.join("、")}。可导出覆盖故障时间的诊断包补充；历史未采集的记录无法补回。` : "",
    ].filter(Boolean);
}
