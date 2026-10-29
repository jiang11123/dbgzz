import { beforeEach, expect, mock, test } from "bun:test";

let failure = false;
let response: unknown;
mock.module("@/services/api/request", () => ({
    ApiError: class extends Error {},
    apiBaseURL: "/api",
    http: {
        get: async () => { if (failure) throw new Error("offline"); return response; },
        post: async (path: string) => {
            if (path === "/assistant/ui-session") return { token: "fixture-ui" };
            if (failure) throw new Error("offline");
            return response;
        },
    },
}));
const { createAssistantSession, activateAssistantSession, getAssistantHistory, listAssistantSessions, resetAgentUiSession } = await import("@/services/api/agent-assistant");
beforeEach(() => { failure = false; response = undefined; resetAgentUiSession(); });

test("C02: rejected create/activate cannot resolve as a new empty conversation", async () => {
    failure = true;
    await expect(createAssistantSession("a")).rejects.toThrow("offline");
    await expect(activateAssistantSession("a", "s2")).rejects.toThrow("offline");
});
test("C05: unavailable history/list are failures, not empty success", async () => {
    failure = true;
    await expect(getAssistantHistory("a")).rejects.toThrow("offline");
    await expect(listAssistantSessions("a")).rejects.toThrow("offline");
});
test("C02: malformed successful session response does not erase the current session", async () => {
    response = {};
    await expect(createAssistantSession("a")).rejects.toThrow();
    await expect(activateAssistantSession("a", "s2")).rejects.toThrow();
});
test("C05: malformed history is distinguished from genuine zero turns", async () => {
    response = {};
    await expect(getAssistantHistory("a")).rejects.toThrow();
    response = { sessionId: "s1", turns: [] };
    expect(await getAssistantHistory("a")).toEqual({ sessionId: "s1", turns: [], active: undefined, plan: null });
});
