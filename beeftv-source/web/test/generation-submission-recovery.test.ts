import { expect, test } from "bun:test";
import { ApiError } from "@/services/api/request";
import { GenerationSubmissionUnknownError, submitGenerationCommand } from "@/services/api/generation-submission";
import type { GenerationTask } from "@/services/api/task-center";

const task = { id: "original", projectId: "canvas", type: "canvas_video", status: "queued" } as GenerationTask;

test("lost response finds the original admission without a second POST", async () => {
    let posts = 0;
    const result = await submitGenerationCommand({ prompt: "coffee" }, "canvas:op", async () => { posts++; throw new ApiError("lost"); }, async () => task);
    expect(result.id).toBe("original");
    expect(posts).toBe(1);
});

test("in-session replay retains original graph, target, configuration and request body", async () => {
    const command = { prompt: "original", input: { metadata: { nodeId: "target" }, config: { model: "first", apiKey: "private-test" } } };
    const seen: unknown[] = [];
    let posts = 0;
    await submitGenerationCommand(command, "canvas:op", async (input) => {
        seen.push(structuredClone(input));
        if (++posts === 1) { command.prompt = "edited"; command.input.config.model = "second"; throw new ApiError("timeout", { status: 408 }); }
        return task;
    }, async () => undefined);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect((seen[1] as typeof command).prompt).toBe("original");
});

test("conflict never retries or mints a new operation", async () => {
    let posts = 0, reads = 0;
    await expect(submitGenerationCommand({ prompt: "changed" }, "canvas:op", async () => { posts++; throw new ApiError("conflict", { status: 409 }); }, async () => { reads++; return undefined; })).rejects.toMatchObject({ status: 409 });
    expect([posts, reads]).toEqual([1, 0]);
});

test("unavailable receipt preserves uncertainty and does not resend", async () => {
    let posts = 0;
    await expect(submitGenerationCommand({ prompt: "test" }, "canvas:op", async () => { posts++; throw new ApiError("network"); }, async () => { throw new ApiError("offline"); })).rejects.toBeInstanceOf(GenerationSubmissionUnknownError);
    expect(posts).toBe(1);
});

test("abandoned scope never replays, but can still discover the original receipt", async () => {
    let posts = 0;
    await expect(submitGenerationCommand({ prompt: "test" }, "canvas:op", async () => { posts++; throw new ApiError("network"); }, async () => undefined, () => false)).rejects.toBeInstanceOf(GenerationSubmissionUnknownError);
    expect(posts).toBe(1);
});
