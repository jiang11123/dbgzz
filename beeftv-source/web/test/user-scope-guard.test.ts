import { describe, expect, test } from "bun:test";

import { captureUserScopeEpoch, getActiveUserScope, getActiveUserScopeEpoch, getUserScopeGeneration, setActiveUserScope, subscribeUserScope, userScopeEpochMatches } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, UserScopeAbandonedError, userScopeMatches } from "@/lib/user-scope-guard";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

describe("user scope guard", () => {
    test("conversation subscribers and upload guards share one epoch", () => {
        const restore = switchScope("owner-a");
        const conversation = captureUserScopeEpoch();
        const media = captureUserScope();
        const seen: number[] = [];
        const unsubscribe = subscribeUserScope((value) => seen.push(value.generation));
        try {
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            expect(seen).toEqual([media.epoch + 1, media.epoch + 2]);
            expect(getUserScopeGeneration()).toBe(getActiveUserScopeEpoch());
            expect(userScopeEpochMatches(conversation)).toBe(false);
            expect(userScopeMatches(media)).toBe(false);
        } finally { unsubscribe(); restore(); }
    });
    test("captures scope plus epoch and does not retain tokens", () => {
        const restore = switchScope("owner-a");
        try {
            const captured = captureUserScope();
            expect(captured.userScope).toBe("owner-a");
            expect(captured.epoch).toBe(getActiveUserScopeEpoch());
            expect(JSON.stringify(captured)).not.toContain("token");
            expect(JSON.stringify(captured)).not.toContain("Bearer");
            assertUserScope(captured);
        } finally {
            restore();
        }
    });

    test("A→B→A reuses the scope string but not the captured identity", () => {
        const restore = switchScope("owner-a");
        try {
            const captured = captureUserScope();
            setActiveUserScope("owner-b");
            expect(userScopeMatches(captured)).toBe(false);
            expect(() => assertUserScope(captured)).toThrow(UserScopeAbandonedError);
            setActiveUserScope("owner-a");
            expect(getActiveUserScope()).toBe("owner-a");
            expect(userScopeMatches(captured)).toBe(false);
            try {
                assertUserScope(captured);
                throw new Error("A→B→A should abandon the original capture");
            } catch (error) {
                expect(isUserScopeAbandonedError(error)).toBe(true);
            }
        } finally {
            restore();
        }
    });

    test("same-string rehydrate still bumps epoch", () => {
        const restore = switchScope("owner-a");
        try {
            const captured = captureUserScope();
            setActiveUserScope("owner-a");
            expect(getActiveUserScope()).toBe("owner-a");
            expect(userScopeMatches(captured)).toBe(false);
        } finally {
            restore();
        }
    });
});
