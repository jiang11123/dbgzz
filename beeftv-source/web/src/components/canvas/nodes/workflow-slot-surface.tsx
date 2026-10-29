import type { ComponentProps, ReactNode } from "react";

/** The same card surface is used by runnable slots and the template editor. */
export function WorkflowSlotSurface({ children, className = "", ...props }: ComponentProps<"div">) {
    return <div {...props} className={`flex h-full w-full flex-col gap-2 rounded-[inherit] bg-[var(--surface-card)] p-3 text-foreground ${className}`}>{children}</div>;
}

export function WorkflowSlotHeader({ label, status }: { label?: ReactNode; status?: ReactNode }) {
    if (!label && !status) return null;
    return <div className="flex min-h-5 items-center justify-between gap-3 text-xs text-muted-foreground">{label ? <span className="min-w-0 truncate">{label}</span> : null}{status ? <span className="ml-auto shrink-0">{status}</span> : null}</div>;
}
