import { http } from "@/services/api/request";

export type EnvironmentCheck = { id: string; title: string; status: "pass" | "warning" | "error" | "repaired" | "skipped" | "unknown"; detail: string; cases: string[] };
export type EnvironmentReport = { checkedAt: string; os: string; arch: string; catalog: { repository: string; revision: string; cases: { id: string; title: string; status: string }[] }; checks: EnvironmentCheck[] };

export { browserChecks, browserCapabilities } from "./browser-environment";

export async function checkEnvironment(repair = false, signal?: AbortSignal): Promise<EnvironmentReport> {
    return http.post<EnvironmentReport>("/diagnostics/environment", { repair }, { signal });
}
