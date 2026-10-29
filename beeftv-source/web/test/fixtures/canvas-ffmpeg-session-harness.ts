import { mergeVideos } from "../../src/lib/canvas/canvas-video-merge";

const inputs = [
    { id: "a", url: "/fixtures/v0.mp4" },
    { id: "b", url: "/fixtures/v1.mp4" },
];

const receipt = { error: "", done: false, bytes: 0, queuedAborted: false };
let controller: AbortController | undefined;

Object.assign(window, {
    canvasFfmpeg: {
        receipt,
        cancel: () => controller?.abort(),
        run: async () => {
            controller = new AbortController();
            receipt.error = "";
            receipt.done = false;
            receipt.bytes = 0;
            try {
                const blob = await mergeVideos(inputs, undefined, controller.signal);
                receipt.bytes = blob.size;
                receipt.done = true;
                return blob.size;
            } catch (error) {
                receipt.error = `${(error as Error).name}: ${(error as Error).message}`;
                throw error;
            }
        },
        runQueuedCancel: async () => {
            const firstController = new AbortController();
            const queuedController = new AbortController();
            receipt.error = "";
            receipt.queuedAborted = false;
            const first = mergeVideos(inputs, undefined, firstController.signal);
            await new Promise((resolve) => setTimeout(resolve, 80));
            const queued = mergeVideos(inputs, undefined, queuedController.signal);
            queuedController.abort();
            await queued.then(() => {
                throw new Error("queued merge should abort");
            }, (error) => {
                if ((error as Error).name !== "AbortError") throw error;
                receipt.queuedAborted = true;
            });
            const blob = await first;
            receipt.bytes = blob.size;
            receipt.done = true;
            return blob.size;
        },
    },
});
