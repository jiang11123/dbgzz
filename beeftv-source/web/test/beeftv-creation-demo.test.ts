import { describe, expect, test } from "bun:test";
import { createDemoConversation } from "../src/pages/create/creation-demo-data";

describe("BeefTV creation conversation demo", () => {
    test("contains a complete mocked planning-to-generation flow", () => {
        const conversation = createDemoConversation();
        expect(conversation.id).toBe("demo-conversation");
        expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
        expect(conversation.messages[1]?.status).toBe("done");
        expect(conversation.messages[3]?.status).toBe("pending");
        expect(conversation.messages[3]?.mode).toBe("video");
    });
});
