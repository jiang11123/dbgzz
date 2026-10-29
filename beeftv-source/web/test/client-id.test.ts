import { describe, expect, test } from "bun:test";

import { createClientId } from "../src/lib/client-id";

describe("createClientId", () => {
    test("randomUUID 缺失时仍使用安全随机数创建 ID", () => {
        const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
        Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
        try {
            const ids = new Set(Array.from({ length: 100 }, () => createClientId()));
            expect(ids.size).toBe(100);
        } finally {
            if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
            else delete (crypto as Partial<Crypto>).randomUUID;
        }
    });
    test("生成不依赖 randomUUID 的唯一客户端标识", () => {
        const ids = Array.from({ length: 100 }, () => createClientId());

        expect(new Set(ids).size).toBe(ids.length);
        ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/));
    });
});
