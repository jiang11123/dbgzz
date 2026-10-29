import { expect, test } from "bun:test";
import { ApiError, request } from "../src/services/api/request";
import { explainGenerationError, formatGenerationDiagnostics } from "../src/lib/generation-error";

test("credential rejection retains local reason and request ID through HTTP and copied diagnostics", async () => {
    const error = await request(Promise.reject({ isAxiosError: true, response: { status: 500, headers: { "x-request-id": "req-credential-test" }, data: { code: 500, reason: "local_credential_failed", msg: "本地算力凭据读取失败，尚未提交生成。工作区密钥文件不存在" } } })).catch(e => e);
    const explained = explainGenerationError(error);
    expect(error.retryable).toBe(false);
    expect(explained.category).toBe("local_credential");
    expect(explained.blockAutomaticRetry).toBe(true);
    const copy = formatGenerationDiagnostics(explained);
    for (const text of ["本地算力连接", "尚未提交生成", "工作区密钥文件不存在", "req-credential-test", "HTTP 状态：500"]) expect(copy).toContain(text);
    expect(copy).not.toContain("模型不接受");
});

test("local disk exhaustion is actionable and hides private paths", () => {
    const admission = new ApiError("本地磁盘空间不足，无法保存数据", {status: 500, reason: "local_disk_full"});
    expect(admission.retryable).toBe(false);
    expect(explainGenerationError(admission).category).toBe("local_disk_full");
    for (const cause of ["There is not enough space on the disk", "no space left on device"]) {
        const explained = explainGenerationError(`生成内容写入资源存储失败：write local resource: write C:\\Users\\private\\video: ${cause}`);
        expect(explained.category).toBe("local_disk_full");
        expect(explained.message).toContain("磁盘空间不足");
        expect(explained.blockAutomaticRetry).toBe(true);
        expect(formatGenerationDiagnostics(explained)).not.toContain("private");
        expect(explainGenerationError(explained.message).category).toBe("local_disk_full");
    }
    expect(explainGenerationError({ status: 500, data: { error: { message: "no space left on device" } } }).category).not.toBe("local_disk_full");
    expect(explainGenerationError({ status: 500, data: { error: { message: "database or disk is full" } } }).category).not.toBe("local_disk_full");
    expect(explainGenerationError({ status: 500, data: { error: { code: "local_disk_full", message: "write local resource: no space left on device" } } }).category).not.toBe("local_disk_full");
});
