import { describe, expect, test } from "bun:test";
import axios from "axios";

import { apiClient } from "@/services/api/request";
import { ResourceUploadError, uploadResourceFile } from "@/services/api/resources";

type AdapterResult = { status: number; body: unknown };

// 直传失败的分类是这条边界的全部价值：permanent 决定调用方是当场报错还是退回本机等待重传。
async function uploadWith(result: AdapterResult | Error) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = async (config) => {
        if (result instanceof Error) throw result;
        if (result.status >= 400) {
            throw new axios.AxiosError(`Request failed with status code ${result.status}`, "ERR_BAD_REQUEST", config, undefined, {
                data: result.body,
                status: result.status,
                statusText: "Error",
                headers: {},
                config,
            });
        }
        return { data: result.body, status: result.status, statusText: "OK", headers: {}, config };
    };
    try {
        return await uploadResourceFile(new Blob(["x"], { type: "image/png" }), "image", { fileName: "x.png" });
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

async function uploadFailure(result: AdapterResult | Error) {
    try {
        await uploadWith(result);
    } catch (error) {
        return error;
    }
    throw new Error("上传本应失败");
}

describe("资源直传失败分类", () => {
    test("鉴权、越权与体积超限属于重试不会自愈的永久失败", async () => {
        for (const status of [400, 401, 403, 404, 413, 415]) {
            const error = await uploadFailure({ status, body: { code: status, data: null, msg: "" } });
            expect(error).toBeInstanceOf(ResourceUploadError);
            expect((error as ResourceUploadError).permanent).toBe(true);
            expect((error as ResourceUploadError).status).toBe(status);
        }
    });

    test("限流与服务端故障属于瞬时失败，允许退回本机后重传", async () => {
        for (const status of [429, 500, 502, 503]) {
            const error = await uploadFailure({ status, body: { code: status, data: null, msg: "" } });
            expect(error).toBeInstanceOf(ResourceUploadError);
            expect((error as ResourceUploadError).permanent).toBe(false);
        }
    });

    test("断网等非 HTTP 失败按瞬时处理", async () => {
        const error = await uploadFailure(new Error("Network Error"));
        expect(error).toBeInstanceOf(ResourceUploadError);
        expect((error as ResourceUploadError).permanent).toBe(false);
    });

    test("保留后端可读文案，并把 multipart 超限翻译成中文", async () => {
        const quota = await uploadFailure({ status: 403, body: { code: 403, data: null, msg: "存储配额不足" } });
        expect((quota as ResourceUploadError).message).toBe("存储配额不足");

        const oversize = await uploadFailure({ status: 400, body: { code: 400, data: null, msg: "http: request body too large" } });
        expect((oversize as ResourceUploadError).message).toContain("文件过大");
        expect((oversize as ResourceUploadError).permanent).toBe(true);
    });

    test("成功响应仍返回后端资源本身", async () => {
        const resource = await uploadWith({
            status: 200,
            body: { code: 0, msg: "", data: { resource: { id: "res-1", kind: "image", status: "ready", publicUrl: "", size: 1 } } },
        });
        expect(resource.id).toBe("res-1");
    });
});
