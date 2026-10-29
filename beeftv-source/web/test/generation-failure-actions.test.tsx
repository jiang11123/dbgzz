import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { explainGenerationError } from "../src/lib/generation-error";

test("uncertain submission offers original task instead of resubmitting", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError({ code: "video_submission_unknown" })} onRetry={() => {}} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("重新生成");
});

test("invalid reference explains limits without repeating unchanged input", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError("第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交")} onRetry={() => {}} />);
    expect(html).toContain("第 2 段参考音频");
    expect(html).toContain("2–30 秒");
    expect(html).not.toContain("重新生成");
});

test("shared batch outputs keep task details without duplicating the full diagnostic controls", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice summaryOnly explanation={explainGenerationError({ code: "submission_uncertain" })} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("复制排查信息");
    expect(html).not.toContain("generation-failure-action\"");
});
