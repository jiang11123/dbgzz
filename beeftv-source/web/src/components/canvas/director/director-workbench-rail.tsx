import { Camera, CircleHelp, GalleryHorizontal, Layers3, RectangleHorizontal, ScanSearch, UserRound } from "lucide-react";
import { Fragment } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

export type DirectorWorkbenchTab = "scene" | "actors" | "cameras" | "panorama" | "aspect" | "assets";

const tabs = [
    { id: "scene", label: "场景", icon: Layers3 },
    { id: "actors", label: "添加角色", icon: UserRound },
    { id: "cameras", label: "添加机位", icon: Camera },
    { id: "panorama", label: "全景图", icon: GalleryHorizontal },
    { id: "aspect", label: "选择画幅比例", icon: RectangleHorizontal },
    { id: "assets", label: "AI 识图导入", icon: ScanSearch },
] as const;

export function DirectorWorkbenchRail({ active, onChange, onHelp }: { active: DirectorWorkbenchTab; onChange: (tab: DirectorWorkbenchTab) => void; onHelp: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <nav aria-label="导演台工作区" className="flex w-12 shrink-0 flex-col items-center gap-2 border-r p-2" style={{ borderColor: theme.toolbar.border }}>
            {tabs.map(({ id, label, icon: Icon }) => (
                <Fragment key={id}>
                <button
                    type="button"
                    aria-label={label}
                    aria-pressed={active === id}
                    title={label}
                    onClick={() => onChange(id)}
                    className="flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2"
                    style={{ background: active === id ? theme.toolbar.itemHover : "transparent", color: active === id ? theme.node.text : theme.node.muted }}
                >
                    <Icon className="size-4" aria-hidden />
                </button>
                {id === "scene" ? <span aria-hidden className="h-2 w-8 border-b" style={{ borderColor: theme.toolbar.border }} /> : null}
                </Fragment>
            ))}
            <button
                type="button"
                aria-label="帮助与快捷键"
                data-director-rail-help="true"
                style={{ marginTop: "auto", color: theme.node.muted }}
                title="帮助与快捷键"
                onClick={onHelp}
                className="mt-auto flex size-8 items-center justify-center rounded-lg outline-none transition-colors hover:bg-white/10 focus-visible:ring-2"
            >
                <CircleHelp className="size-4" aria-hidden />
            </button>
        </nav>
    );
}
