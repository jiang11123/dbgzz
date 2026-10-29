import { CheckCircle2, CircleAlert } from "lucide-react";

export function DirectorExportNotice({ kind, text, background }: { kind: "success" | "warning" | "error"; text: string; background?: string }) {
    const success = kind === "success";
    const warning = kind === "warning";
    return <div role={success || warning ? "status" : "alert"} aria-live={success || warning ? "polite" : "assertive"} className="director-workbench-topbar-group max-w-[min(480px,calc(100vw-300px))] gap-2 truncate px-3 text-xs" style={{ background, color: success ? "var(--status-success)" : warning ? "var(--status-warning)" : "var(--status-error)" }}>
        {success ? <CheckCircle2 className="size-4 shrink-0" aria-hidden /> : <CircleAlert className="size-4 shrink-0" aria-hidden />}
        <span className="truncate">{text}</span>
    </div>;
}
