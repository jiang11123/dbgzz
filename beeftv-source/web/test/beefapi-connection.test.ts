import { expect, spyOn, test } from "bun:test";
import { beefAPIConnectionLabel, startBeefAPIConnection, type BeefAPIConnectionSummary } from "../src/services/api/beefapi-connection";
import { http } from "../src/services/api/request";

test("connection labels stay user-facing and distinct", () => {
    const cases: Array<[BeefAPIConnectionSummary, string]> = [
        [{ state: "disconnected", hasCredential: false }, "未连接"],
        [{ state: "connecting", hasCredential: false }, "正在连接 BeefTV"],
        [{ state: "connecting", errorReason: "正在尝试其他连接方式", hasCredential: false }, "正在尝试其他连接方式"],
        [{ state: "connection_error", hasCredential: false }, "无法连接 BeefTV 服务，请检查网络后重试"],
        [{ state: "connection_error", errorReason: "BeefTV 连接服务暂时不可用，请稍后重试", hasCredential: false }, "BeefTV 连接服务暂时不可用，请稍后重试"],
        [{ state: "pending", userCode: "WXYZ-1234", hasCredential: false }, "请在浏览器中确认 WXYZ-1234"],
        [{ state: "pending", userCode: "WXYZ-1234", errorReason: "连接中断，正在重试", hasCredential: false }, "连接中断，正在重试"],
        [{ state: "pending", userCode: "WXYZ-1234", errorReason: "正在完成连接确认", hasCredential: true }, "正在完成连接确认"],
        [{ state: "connected", account: { id: "1", display_name: "工作室" }, hasCredential: true }, "已连接 工作室"],
        [{ state: "connected", account: { id: "1", display_name: "工作室" }, balance: "zero", hasCredential: true }, "已连接 工作室，余额为 0"],
        [{ state: "expired", hasCredential: false }, "授权已过期，请重新连接"],
        [{ state: "cancelled", hasCredential: false }, "已取消本次连接"],
        [{ state: "rejected", hasCredential: false }, "授权被拒绝"],
        [{ state: "store_error", hasCredential: false }, "保存连接失败，请重试"],
        [{ state: "catalog_failed", hasCredential: true }, "模型列表读取失败，请重试"],
        [{ state: "revoked", hasCredential: true }, "连接已失效，请重新连接"],
    ];
    for (const [summary, label] of cases) {
        expect(beefAPIConnectionLabel(summary)).toBe(label);
    }
});

test("starting authorization waits beyond the backend connection budget and preserves cancellation", async () => {
    const controller = new AbortController();
    const post = spyOn(http, "post").mockResolvedValue({ state: "pending", hasCredential: false });
    try {
        await startBeefAPIConnection(controller.signal);
        expect(post).toHaveBeenCalledWith("/beefapi/connection/start", {}, { signal: controller.signal, timeout: 35_000 });
    } finally {
        post.mockRestore();
    }
});
