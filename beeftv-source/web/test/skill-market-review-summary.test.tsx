import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketReviewSummary } from "../src/pages/skills/market-review-summary";
import type { SkillReviewSummary } from "../src/services/api/skill-market";

test("installation review shows both tested scenarios and their actual environment without private examples", () => {
    const review = {
        reviewedAt: "2026-10-21T06:00:00Z", revision: 3, contentHash: "hash", archiveSha256: "archive", previewDigest: "preview",
        trials: ["normal", "missing_input"].map(scenario => ({ scenario, target: "beeftv", runtimeVersion: "v2.0.1-skill.1", model: "review-model", conclusion: "passed", testedAt: "2026-10-21T05:00:00Z", input: "private-input", output: "private-output" })),
    };
    const html = renderToStaticMarkup(<MarketReviewSummary review={review} />);
    for (const text of ["正常使用", "缺少输入", "通过", "BeefTV", "v2.0.1-skill.1", "review-model", "2026-10-21T05:00:00Z", "审核时间"]) expect(html).toContain(text);
    expect(html).not.toContain("private-input");
    expect(html).not.toContain("private-output");
});

test("absent or unfamiliar review conclusions are not presented as passed", () => {
    expect(renderToStaticMarkup(<MarketReviewSummary />)).toContain("尚未提供公开实测记录");
    const review = { reviewedAt: "", trials: [{ scenario: "future", target: "other", runtimeVersion: "unknown", model: "unknown", conclusion: "pending", testedAt: "" }] } as SkillReviewSummary;
    const html = renderToStaticMarkup(<MarketReviewSummary review={review} />);
    expect(html).toContain("未确认通过");
    expect(html).toContain("其他样例");
    expect(html).toContain("时间未记录");
});
