import { afterEach, describe, expect, test } from "bun:test";

import { apiClient } from "../src/services/api/request";
import { getResourcePlaybackBlob } from "../src/services/api/resources";

describe("asset video playback resource", () => {
    const originalAdapter = apiClient.defaults.adapter;

    afterEach(() => {
        apiClient.defaults.adapter = originalAdapter;
    });

    test("loads the browser playback variant through the authenticated proxy without a short timeout", async () => {
        const media = new Blob(["video-bytes"], { type: "video/mp4" });
        let requestUrl = "";
        let requestConfig: Record<string, unknown> | undefined;
        apiClient.defaults.adapter = async (config) => {
            requestUrl = config.url || "";
            requestConfig = config as Record<string, unknown>;
            return { data: media, status: 200, statusText: "OK", headers: {}, config };
        };

        await expect(getResourcePlaybackBlob("resource:video 1")).resolves.toBe(media);
        expect(requestUrl).toBe("/resources/video%201/file?variant=playback&proxy=1");
        expect(requestConfig).toMatchObject({
            responseType: "blob",
            timeout: 0,
        });
    });

    test("does not request a playback variant without a resource storage key", async () => {
        let requested = false;
        apiClient.defaults.adapter = async (config) => {
            requested = true;
            return { data: new Blob(), status: 200, statusText: "OK", headers: {}, config };
        };

        await expect(getResourcePlaybackBlob("local:video-1")).resolves.toBeNull();
        expect(requested).toBe(false);
    });
});
