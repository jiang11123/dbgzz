import { PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import { Link, useLocation } from "react-router";

import { WorkspaceTopBarExtensionSlot } from "@/components/layout/workspace-top-bar-extension";
import { useAppearanceStore } from "@/stores/use-appearance-store";

const PAGE_TITLES: Record<string, string> = {
    home: "创作", create: "创作", projects: "项目", canvas: "自由画布",
    assets: "资产", skills: "技能", plugins: "插件", settings: "设置",
};

/** Compatibility workspace chrome retained for non-canvas routes. Canvas owns its own top bar. */
export function WorkspaceTopBar({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const { pathname } = useLocation();
    const slug = pathname.split("/").filter(Boolean)[0];
    const pageTitle = slug ? PAGE_TITLES[slug] || brandName : PAGE_TITLES.home;
    const isHome = pathname === "/";

    return (
        <header className="app-workspace-topbar">
            <button type="button" className="app-workspace-mobile-menu app-workspace-topbar-icon-button" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"} onClick={onToggleSidebar}>
                {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
            </button>
            {!isHome ? <nav className="app-workspace-topbar-breadcrumb" aria-label="当前位置">
                <Link to="/" className="font-medium text-foreground/65 transition-colors hover:text-foreground">{brandName}</Link>
                <span aria-hidden="true">/</span>
                <span className="truncate font-medium text-foreground">{pageTitle}</span>
            </nav> : <span className="app-workspace-topbar-spacer" />}
            <WorkspaceTopBarExtensionSlot />
            <div className="app-workspace-topbar-actions">
                <Link to="/settings?section=channels" className="app-workspace-topbar-utility"><Settings2 /><span>模型配置</span></Link>
            </div>
        </header>
    );
}
