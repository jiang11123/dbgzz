import { expect, test } from "bun:test";

import { GENERATION_RESULT_FETCH_STAGE, generationDeliveryProgressView, generationTaskFetchingResult } from "@/lib/generation-delivery-progress";

test("取回进度显示百分比、已下载/总大小和速度", () => {
    expect(generationDeliveryProgressView({ outputIndex: 0, downloadedBytes: 12_900_000, totalBytes: 41_943_040, bytesPerSecond: 1_258_291, state: "downloading", updatedAt: 1000 }, 1000)).toEqual({
        title: "正在取回结果",
        percent: 30,
        detail: "12 MB / 40 MB · 1.2 MB/s · 预计剩余 24 秒",
        size: "12 MB / 40 MB", speed: "1.2 MB/s", timing: "预计剩余 24 秒",
    });
});
test("取回样本过期后隐藏旧速度和剩余时间", () => {
    expect(generationDeliveryProgressView({ outputIndex: 0, downloadedBytes: 2048, totalBytes: 4096, bytesPerSecond: 1024, state: "downloading", updatedAt: 1000 }, 5000).detail).toBe("2.0 KB / 4.0 KB");
});

test("总大小未知时只显示已下载量，中断续传时不显示速度", () => {
    expect(generationDeliveryProgressView({ outputIndex: 0, downloadedBytes: 2048, totalBytes: -1, bytesPerSecond: 0, state: "retrying" })).toEqual({
        title: "下载中断，正在重试",
        percent: null,
        detail: "2.0 KB",
        size: "2.0 KB", speed: "", timing: "",
    });
});

test("等待结果就绪时显示取回中，不给出字节或速度", () => {
    expect(generationDeliveryProgressView({ outputIndex: 0, downloadedBytes: 0, totalBytes: -1, bytesPerSecond: 0, state: "waiting" })).toEqual({
        title: "正在取回结果",
        percent: null,
        detail: "等待结果就绪",
        size: "", speed: "", timing: "等待结果就绪",
    });
});

test("生成结果取回阶段和已有进度都算取回中", () => {
    expect(generationTaskFetchingResult({ status: "running", stage: GENERATION_RESULT_FETCH_STAGE }, false)).toBe(true);
    expect(generationTaskFetchingResult({ status: "running", stage: "正在生成" }, false)).toBe(false);
    expect(generationTaskFetchingResult({ status: "running", stage: GENERATION_RESULT_FETCH_STAGE }, true)).toBe(true);
    expect(generationTaskFetchingResult({ status: "succeeded" }, false)).toBe(true);
    expect(generationTaskFetchingResult({ status: "queued", stage: GENERATION_RESULT_FETCH_STAGE }, false)).toBe(false);
});
