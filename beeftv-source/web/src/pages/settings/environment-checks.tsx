import { Button } from "antd";
import { useEffect, useRef, useState } from "react";
import { browserCapabilities, browserChecks, checkEnvironment, type EnvironmentCheck } from "@/services/diagnostics/environment-check";
import { probeBrowserStorage } from "@/services/diagnostics/browser-environment";

const labels: Record<EnvironmentCheck["status"], string> = { pass: "正常", warning: "需留意", error: "需处理", repaired: "已修复", skipped: "可选", unknown: "未确认" };

export function EnvironmentChecks() {
    const [checks, setChecks] = useState<EnvironmentCheck[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const active = useRef<AbortController | null>(null);
    async function run() {
        active.current?.abort();
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        setError("");
        const storage = await probeBrowserStorage(controller.signal);
        if (controller.signal.aborted) return;
        const client = browserChecks({ ...browserCapabilities(), ...storage });
        try {
            const report = await checkEnvironment(true, controller.signal);
            if (controller.signal.aborted) return;
            setChecks([...report.checks, ...client]);
        } catch {
            if (controller.signal.aborted) return;
            setChecks(client);
            setError("本地服务检查未完成，以下仅为浏览器检查结果。请确认后端运行后重试。");
        } finally { if (!controller.signal.aborted) setBusy(false); }
    }
    useEffect(() => { void run(); return () => active.current?.abort(); }, []);
    return <section aria-label="环境自检" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">环境自检</h3>
            <Button aria-label="重新检查" aria-busy={busy} disabled={busy} onClick={() => void run()}>{busy ? "检查中" : "重新检查"}</Button>
        </div>
        <p className="text-xs leading-5 text-foreground/55">仅补建缺失的临时目录。结果随诊断包导出。</p>
        {busy ? <p role="status" className="text-xs text-foreground/55">正在检查运行环境…</p> : null}
        {error ? <p role="alert" className="text-xs leading-5 text-destructive">{error}</p> : null}
        <ul className="divide-y divide-border" aria-busy={busy}>
            {checks.map((check) => <li key={check.id} className="py-2">
                <div className="flex justify-between gap-3 text-xs"><span className="font-medium">{check.title}</span><span className={check.status === "error" ? "shrink-0 text-destructive" : "shrink-0 text-foreground/65"}>{labels[check.status]}</span></div>
                {check.status !== "pass" ? <p className="mt-1 text-xs leading-5 text-foreground/65">{check.detail}</p> : null}
            </li>)}
        </ul>
    </section>;
}
