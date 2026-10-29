import { describe, expect, test } from "bun:test";

import { clampOpenAIPromptCacheKey, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, withOpenAIPromptCacheKey } from "../src/lib/openai-prompt-cache";

describe("OpenAI prompt cache key", () => {
    test("缓存键按 OpenAI 上限截断", () => {
        const key = clampOpenAIPromptCacheKey(`canvas-session:${"x".repeat(100)}`);
        expect(Array.from(key || "")).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
    });

    test("Responses 请求体携带缓存键", () => {
        const body = withOpenAIPromptCacheKey({ model: "test-model", input: [] }, " canvas-session:session-a ");
        expect(body.prompt_cache_key).toBe("canvas-session:session-a");
    });

    test("空缓存键不会写入 Responses 请求体", () => {
        const body = withOpenAIPromptCacheKey({ model: "test-model", input: [] }, " ");
        expect(body).not.toHaveProperty("prompt_cache_key");
    });
});
