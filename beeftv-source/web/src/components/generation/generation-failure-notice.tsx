import { Copy, Eye, RefreshCw } from "lucide-react";
import { useState } from "react";

import { formatGenerationDiagnostics, type GenerationFailureContext, type GenerationFailureExplanation } from "@/lib/generation-error";
import { getDiagnosticTraceId } from "@/services/diagnostics/client-diagnostics";

type GenerationFailureNoticeProps = {
    explanation: GenerationFailureExplanation;
    context?: GenerationFailureContext;
    compact?: boolean;
    onRetry?: () => void;
    retryLabel?: string;
    onOpenDetails?: () => void;
    retryDisabled?: boolean;
    summaryOnly?: boolean;
};

export function GenerationFailureNotice({ explanation, context, compact, onRetry, retryLabel, onOpenDetails, retryDisabled, summaryOnly }: GenerationFailureNoticeProps) {
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const diagnostics = formatGenerationDiagnostics(explanation, { ...context, traceId: context?.traceId || getDiagnosticTraceId(context?.taskId || explanation.taskId) });
    const showRetry = Boolean(onRetry) && !explanation.blockManualRetry && !retryDisabled;
    const copyDiagnostics = async () => {
        try {
            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(diagnostics);
            } else {
                const copied = fallbackCopy(diagnostics);
                if (!copied) throw new Error("copy failed");
            }
            setCopyState("copied");
            window.setTimeout(() => setCopyState("idle"), 1600);
        } catch {
            setCopyState("failed");
            window.setTimeout(() => setCopyState("idle"), 2200);
        }
    };
    return (
        <div className={`generation-failure-notice${compact ? " is-compact" : ""}`}>
            <p className="generation-failure-reason">{explanation.reason}</p>
            {!summaryOnly && explanation.action ? <p className="generation-failure-action">{explanation.action}</p> : null}
            <div className="generation-failure-actions">
                {onOpenDetails ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpenDetails();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <Eye className="size-3.5" />
                        {explanation.uncertain ? "查看原任务" : "查看详情"}
                    </button>
                ) : null}
                {!summaryOnly && diagnostics ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            void copyDiagnostics();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <Copy className="size-3.5" />
                        {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制排查信息"}
                    </button>
                ) : null}
                {showRetry ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onRetry?.();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <RefreshCw className="size-3.5" />
                        {retryLabel || "重新生成"}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function fallbackCopy(value: string) {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
}
