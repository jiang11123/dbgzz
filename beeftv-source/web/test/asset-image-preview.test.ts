import { afterEach, expect, test } from "bun:test";

import { apiClient } from "../src/services/api/request";
import { getResourceBlob } from "../src/services/api/resources";

const originalAdapter = apiClient.defaults.adapter;

afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
});

test("image preview fetches the full resource through the authenticated media client", async () => {
    const image = new Blob(["image-bytes"], { type: "image/png" });
    let requestUrl = "";
    let requestConfig: Record<string, unknown> | undefined;
    apiClient.defaults.adapter = async (config) => {
        requestUrl = config.url || "";
        requestConfig = config as Record<string, unknown>;
        return { data: image, status: 200, statusText: "OK", headers: {}, config };
    };

    await expect(getResourceBlob("resource:image 1")).resolves.toBe(image);
    expect(requestUrl).toBe("/resources/image%201/file?proxy=1");
    expect(requestConfig).toMatchObject({ responseType: "blob", timeout: 0 });
});
