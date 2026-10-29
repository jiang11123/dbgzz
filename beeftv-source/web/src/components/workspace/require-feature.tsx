import type { ReactNode } from "react";
import { Button } from "antd";
import { useNavigate } from "react-router";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { useUserStore } from "@/stores/use-user-store";

type FeatureKey = "shortDramaEnabled" | "taskCenterEnabled" | "frontendModelsEnabled" | "pluginCenterEnabled";

const featureNames: Record<FeatureKey, string> = {
    shortDramaEnabled: "短剧创作",
    taskCenterEnabled: "任务中心",
    frontendModelsEnabled: "前台模型",
    pluginCenterEnabled: "插件中心",
};

export function RequireFeature({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const features = useUserStore((state) => state.features);
    if (!features[feature]) {

        return (
            <WorkspacePage>
                <WorkspaceState icon="empty" title={`${featureNames[feature]}暂不可用`} description="当前本地工作区未启用此模块。" action={<Button type="primary" onClick={() => navigate("/", { replace: true })}>返回创作台</Button>} />
            </WorkspacePage>
        );
    }
    return children;
}
