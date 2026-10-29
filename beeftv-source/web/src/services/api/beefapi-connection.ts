import { http } from "@/services/api/request";

let connectionEpoch = 0;
export function getBeefAPIConnectionEpoch() {
    return connectionEpoch;
}

export type BeefAPIAccount = {
    id: string;
    username?: string;
    display_name?: string;
    email?: string;
};

export type BeefAPIConnectionState = "disconnected" | "connecting" | "connection_error" | "pending" | "connected" | "expired" | "cancelled" | "rejected" | "store_error" | "catalog_failed" | "revoked";

export type BeefAPIConnectionSummary = {
    state: BeefAPIConnectionState | string;
    userCode?: string;
    verificationUri?: string;
    expiresAt?: string;
    account?: BeefAPIAccount | null;
    keyName?: string;
    tokenId?: string;
    market?: string;
    walletUrl?: string;
    balance?: "unknown" | "zero" | "available" | string;
    catalogFailed?: boolean;
    errorReason?: string;
    connectedAt?: string;
    credentialRef?: string;
    hasCredential?: boolean;
};

export function getBeefAPIConnection(signal?: AbortSignal) {
    return http.get<BeefAPIConnectionSummary>("/beefapi/connection", { signal });
}

export function startBeefAPIConnection(signal?: AbortSignal) {
    connectionEpoch++;
    // Authorization may need a proxy handshake and one safe direct attempt.
    return http.post<BeefAPIConnectionSummary>("/beefapi/connection/start", {}, { signal, timeout: 35_000 });
}

export function cancelBeefAPIConnection(signal?: AbortSignal) {
    connectionEpoch++;
    return http.post<BeefAPIConnectionSummary>("/beefapi/connection/cancel", {}, { signal });
}

export function disconnectBeefAPIConnection(signal?: AbortSignal) {
    connectionEpoch++;
    return http.post<BeefAPIConnectionSummary>("/beefapi/connection/disconnect", {}, { signal });
}

export function openBeefAPIWallet(signal?: AbortSignal) {
    return http.post<{ opened: boolean }>("/beefapi/connection/open-wallet", {}, { signal });
}

export function beefAPIConnectionLabel(summary: BeefAPIConnectionSummary | null | undefined) {
    const state = summary?.state || "disconnected";
    switch (state) {
        case "connecting":
            return summary?.errorReason || "正在连接 BeefTV";
        case "connection_error":
            return summary?.errorReason || "无法连接 BeefTV 服务，请检查网络后重试";
        case "pending":
            return summary?.errorReason || (summary?.userCode ? `请在浏览器中确认 ${summary.userCode}` : "请在浏览器中确认授权");
        case "connected":
            return connectedAccountLabel(summary);
        case "expired":
            return "授权已过期，请重新连接";
        case "cancelled":
            return "已取消本次连接";
        case "rejected":
            return "授权被拒绝";
        case "store_error":
            return "保存连接失败，请重试";
        case "catalog_failed":
            return "模型列表读取失败，请重试";
        case "revoked":
            return "连接已失效，请重新连接";
        default:
            return "未连接";
    }
}

function connectedAccountLabel(summary: BeefAPIConnectionSummary | null | undefined) {
    const account = summary?.account;
    const name = account?.email || account?.display_name || account?.username;
    if (name && summary?.balance === "zero") return `已连接 ${name}，余额为 0`;
    if (name) return `已连接 ${name}`;
    if (summary?.balance === "zero") return "已连接，余额为 0";
    return "已连接";
}
