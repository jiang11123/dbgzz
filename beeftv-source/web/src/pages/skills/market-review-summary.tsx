import type { SkillReviewSummary } from "@/services/api/skill-market";

function reviewTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未记录" : date.toLocaleString("zh-CN", { hour12: false });
}

export function MarketReviewSummary({ review }: { review?: SkillReviewSummary }) {
    return <section aria-label="审核实测记录">
        <h3>审核实测记录</h3>
        {!review?.trials.length ? <p>此版本尚未提供公开实测记录。</p> : <>
            <p>审核时间：<time dateTime={review.reviewedAt}>{reviewTime(review.reviewedAt)}</time></p>
            <ul className="skill-market-trials">{review.trials.map((trial, index) => <li key={index}>
                <strong>{({ normal: "正常使用", missing_input: "缺少输入" } as Record<string, string>)[trial.scenario] || "其他样例"} · {trial.conclusion === "passed" ? "通过" : "未确认通过"}</strong>
                <p>运行环境：{({ beeftv: "BeefTV", codex: "Codex", "claude-code": "Claude Code" } as Record<string, string>)[trial.target] || trial.target} · {trial.runtimeVersion}</p>
                <p>使用模型：{trial.model}</p>
                <p>试用时间：<time dateTime={trial.testedAt}>{reviewTime(trial.testedAt)}</time></p>
            </li>)}</ul>
            <p className="skill-market-meta">记录只反映上述环境和模型的试用结果；更换模型或素材后，效果可能不同。</p>
        </>}
    </section>;
}
