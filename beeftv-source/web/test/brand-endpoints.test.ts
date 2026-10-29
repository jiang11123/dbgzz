import { expect, test } from "bun:test";
import { isBeefAPIEndpoint } from "../src/lib/beefapi-video-contracts";
import { beefAPIConnectionLabel } from "../src/services/api/beefapi-connection";
import { channelRequest } from "../src/services/api/custom-channel-relay";

test("both brands retain strict managed endpoint recognition and relay credentials", () => {
    for (const baseUrl of ["https://beeftv.app", "https://enterprise.beefapi.com"]) {
        expect(isBeefAPIEndpoint(baseUrl + "/v1")).toBe(true);
        const request = channelRequest({baseUrl, apiKey: "", apiFormat: "openai"}, baseUrl + "/v1/models");
        expect(request.url).toContain("/ai/custom");
        expect(JSON.stringify(request)).not.toContain("Bearer ");
    }
    for (const baseUrl of ["http://beeftv.app", "https://beeftv.app:444", "https://beeftv.app.evil.test", "https://user@beeftv.app", "https://evil.test/beeftv.app"]) {
        expect(isBeefAPIEndpoint(baseUrl)).toBe(false);
    }
});

test("connected identity prefers email over display name and username", () => {
    expect(beefAPIConnectionLabel({state: "connected", account: {id: "1", email: "creator@example.com", display_name: "Creator", username: "legacy"}})).toBe("已连接 creator@example.com");
});
