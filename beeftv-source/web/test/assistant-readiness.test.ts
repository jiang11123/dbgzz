import { expect, test } from "bun:test";
import { waitForAssistant } from "@/pages/canvas/assistant-readiness";

test("preparing can become ready before any chat is dispatched", async () => {
    let reads = 0;
    const status = await waitForAssistant(new AbortController().signal, async () => ++reads === 1 ? { available: false, reason: "host_starting" } : { available: true });
    expect(status.available).toBe(true);
    expect(reads).toBe(2);
});
test("configuration errors fail immediately instead of polling forever", async () => {
    let reads = 0;
    await expect(waitForAssistant(new AbortController().signal, async () => { reads++; return { available: false, reason: "credential_missing" }; })).rejects.toThrow();
    expect(reads).toBe(1);
});
test("stop while preparing prevents dispatch", async () => {
    const controller = new AbortController();
    const pending = waitForAssistant(controller.signal, async () => ({ available: false, reason: "host_starting" }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
});
