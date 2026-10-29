import { useEffect, useState } from "react";
import { Link } from "react-router";
import { listPublishPlans, type PublishPlan } from "@/services/api/skill-market";

export function AssistantPublicationEntry({ canvasId, turnCount, running }: { canvasId: string; turnCount: number; running: boolean }) {
    const [plans, setPlans] = useState<PublishPlan[]>([]);
    useEffect(() => {
        let cancelled = false;
        setPlans([]);
        if (!running) void listPublishPlans().then(value => {
            if (!cancelled) setPlans(value.items.filter(plan => plan.canvasId === canvasId && ["awaiting_upload_confirmation", "uploading", "awaiting_submit_confirmation", "needs_preview"].includes(plan.status)));
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [canvasId, turnCount, running]);
    if (!plans.length) return null;
    return <div className="canvas-assistant-card" aria-label="技能投稿待确认"><p>助手已准备技能草稿。请检查文件，再分别确认上传和送审。</p>{plans.map(plan => <p key={plan.planId}><Link to={`/skills?tab=publish&planId=${encodeURIComponent(plan.planId)}`}>检查“{plan.metadata.name}”投稿</Link></p>)}</div>;
}
