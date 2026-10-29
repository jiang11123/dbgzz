import { expect, test } from "bun:test";
import { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";

const input = { projectId: "video-barrier-canvas", nodeId: "video-result", mode: "video" as const, prompt: "test", config: {} as never };

test("video submission waits for its target to be saved", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pendingSave = new Promise<void>((resolve) => { release = resolve; });
    const stopAtSubmission = new Error("controlled submission boundary");
    const running = runCanvasGenerationTaskToConsumer({ ...input, clientOperationId: "video-save-wait" }, {
        prepareTarget: async () => { events.push("save"); await pendingSave; events.push("saved"); },
        bindTask: () => undefined,
        consumeTask: async () => undefined,
        runTask: async () => { events.push("submit"); throw stopAtSubmission; },
    }).catch((error: unknown) => error);
    try {
        await Promise.resolve();
        expect(events).toEqual(["save"]);
    } finally {
        release();
        expect(await running).toBe(stopAtSubmission);
    }
    expect(events).toEqual(["save", "saved", "submit"]);
});

test("a rejected video target save prevents task submission", async () => {
    const saveFailure = new Error("controlled target save failure");
    let submissions = 0;
    await expect(runCanvasGenerationTaskToConsumer({ ...input, clientOperationId: "video-save-rejected" }, {
        prepareTarget: async () => { throw saveFailure; },
        bindTask: () => undefined,
        consumeTask: async () => undefined,
        runTask: async () => { submissions++; throw new Error("unexpected submission"); },
    })).rejects.toBe(saveFailure);
    expect(submissions).toBe(0);
});
