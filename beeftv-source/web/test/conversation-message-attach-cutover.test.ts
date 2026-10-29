import { beforeEach, describe, expect, test } from "bun:test";

import { UserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { bindBackendConversationMessageResult, ConversationBindProjectionAdoptionError } from "@/services/conversation-generation-consumer";
import type { ConversationMessageAttachReceipt } from "@/services/api/operations";
import type { StoredCreationConversation } from "@/services/creation-conversation-store";
import type { GenerationTask } from "@/services/api/task-center";

function captured(userScope: string, epoch: number): CapturedUserScope {
    return { userScope, epoch };
}

function conversationDoc(id: string, messageId: string, extra: Record<string, unknown> = {}): StoredCreationConversation {
    return {
        id,
        title: "创作对话",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: messageId, role: "assistant", status: "done", content: "图片已生成", taskIds: ["task-1"], resultUrls: ["/api/resources/res-1/file"], ...extra },
        ],
    };
}

function succeededTask(): GenerationTask {
    return {
        id: "task-1",
        type: "canvas_image",
        status: "succeeded",
        prompt: "猫",
        attempts: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        clientContext: { conversationId: "conv-1", messageId: "msg-1" },
        outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "generation_abc" }],
    };
}

function receipt(document: StoredCreationConversation, extra: Partial<ConversationMessageAttachReceipt> = {}): ConversationMessageAttachReceipt {
    return {
        applied: true,
        conversationId: "conv-1",
        messageId: "msg-1",
        taskId: "task-1",
        outputIndex: 0,
        bindingStatus: "bound",
        content: "图片已生成",
        resultUrls: ["/api/resources/res-1/file"],
        revision: 4,
        conversation: document,
        ...extra,
    };
}

describe("bindBackendConversationMessageResult", () => {
    beforeEach(() => undefined);

    test("adopts the canonical conversation and passes the same captured scope object", async () => {
        const identity = captured("user-a", 1);
        const document = conversationDoc("conv-1", "msg-1");
        const seen: unknown[] = [];

        const bound = await bindBackendConversationMessageResult({
            conversationId: "conv-1",
            messageId: "msg-1",
            task: succeededTask(),
            runtime: {
                attachMessage: async (input) => {
                    expect(input.expectedScope).toBe(identity);
                    seen.push(input.expectedScope);
                    return { op: "conversation.message.attach", opId: input.operationId, replayed: false, revision: 4, result: receipt(document) };
                },
                adoptConfirmedConversation: async (_id, next, revision, scope) => {
                    seen.push(scope);
                    expect(revision).toBe(4);
                    return next;
                },
                captureScope: () => identity,
                liveScope: () => identity,
            },
        });

        expect(bound.content).toBe("图片已生成");
        expect(bound.resultUrls).toEqual(["/api/resources/res-1/file"]);
        expect(bound.conversation?.id).toBe("conv-1");
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(identity);
        expect(seen[1]).toBe(identity);
    });

    test("deleted message does not resurrect from historical receipt content", async () => {
        const identity = captured("user-a", 1);
        let adopted = 0;
        const bound = await bindBackendConversationMessageResult({
            conversationId: "conv-1",
            messageId: "msg-1",
            task: succeededTask(),
            runtime: {
                attachMessage: async (input) => ({
                    op: "conversation.message.attach",
                    opId: input.operationId,
                    replayed: true,
                    revision: 6,
                    result: {
                        applied: true,
                        conversationId: "conv-1",
                        messageId: "msg-1",
                        taskId: "task-1",
                        bindingStatus: "deleted",
                        historical: { content: "图片已生成", resultUrls: ["/api/resources/res-old/file"] },
                    },
                }),
                adoptConfirmedConversation: async () => {
                    adopted += 1;
                    throw new Error("deleted replay must not adopt");
                },
                captureScope: () => identity,
                liveScope: () => identity,
            },
        });
        expect(bound.receipt.bindingStatus).toBe("deleted");
        expect(bound.resultUrls).toEqual([]);
        expect(adopted).toBe(0);
    });

    test("replaced task keeps the current conversation and does not overlay the old result", async () => {
        const identity = captured("user-a", 1);
        const current = conversationDoc("conv-1", "msg-1", { taskIds: ["task-b"], content: "视频已生成", resultUrls: ["/api/resources/res-b/file"] });
        const bound = await bindBackendConversationMessageResult({
            conversationId: "conv-1",
            messageId: "msg-1",
            task: succeededTask(),
            runtime: {
                attachMessage: async (input) => ({
                    op: "conversation.message.attach",
                    opId: input.operationId,
                    replayed: true,
                    revision: 8,
                    result: receipt(current, {
                        bindingStatus: "replaced",
                        taskId: "task-1",
                        historical: { taskId: "task-1", content: "图片已生成" },
                    }),
                }),
                adoptConfirmedConversation: async (_id, document) => document,
                captureScope: () => identity,
                liveScope: () => identity,
            },
        });
        const message = (bound.conversation?.messages as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === "msg-1");
        expect(bound.receipt.bindingStatus).toBe("replaced");
        expect(message?.taskIds).toEqual(["task-b"]);
        expect(message?.content).toBe("视频已生成");
    });

    test("account switch after attach does not adopt into the next account", async () => {
        let live = captured("user-a", 1);
        let adopted = 0;
        await expect(
            bindBackendConversationMessageResult({
                conversationId: "conv-1",
                messageId: "msg-1",
                task: succeededTask(),
                runtime: {
                    attachMessage: async (input) => {
                        live = captured("user-b", 2);
                        return { op: "conversation.message.attach", opId: input.operationId, replayed: false, revision: 4, result: receipt(conversationDoc("conv-1", "msg-1")) };
                    },
                    adoptConfirmedConversation: async () => {
                        adopted += 1;
                        throw new Error("should not adopt");
                    },
                    captureScope: () => captured("user-a", 1),
                    liveScope: () => live,
                },
            }),
        ).rejects.toBeInstanceOf(UserScopeAbandonedError);
        expect(adopted).toBe(0);
    });

    test("bound receipt without revision throws instead of adopting a local fallback", async () => {
        const identity = captured("user-a", 1);
        let adopted = 0;
        await expect(
            bindBackendConversationMessageResult({
                conversationId: "conv-1",
                messageId: "msg-1",
                task: succeededTask(),
                runtime: {
                    attachMessage: async (input) => ({
                        op: "conversation.message.attach",
                        opId: input.operationId,
                        replayed: false,
                        result: { applied: true, conversationId: "conv-1", messageId: "msg-1", taskId: "task-1", bindingStatus: "bound", conversation: conversationDoc("conv-1", "msg-1") },
                    }),
                    adoptConfirmedConversation: async () => {
                        adopted += 1;
                        throw new Error("missing revision must not adopt");
                    },
                    captureScope: () => identity,
                    liveScope: () => identity,
                },
            }),
        ).rejects.toBeInstanceOf(ConversationBindProjectionAdoptionError);
        expect(adopted).toBe(0);
    });

    test("bound receipt without conversation document throws", async () => {
        const identity = captured("user-a", 1);
        await expect(
            bindBackendConversationMessageResult({
                conversationId: "conv-1",
                messageId: "msg-1",
                task: succeededTask(),
                runtime: {
                    attachMessage: async (input) => ({
                        op: "conversation.message.attach",
                        opId: input.operationId,
                        replayed: false,
                        revision: 4,
                        result: { applied: true, conversationId: "conv-1", messageId: "msg-1", taskId: "task-1", bindingStatus: "bound", revision: 4 },
                    }),
                    captureScope: () => identity,
                    liveScope: () => identity,
                },
            }),
        ).rejects.toBeInstanceOf(ConversationBindProjectionAdoptionError);
    });
});
