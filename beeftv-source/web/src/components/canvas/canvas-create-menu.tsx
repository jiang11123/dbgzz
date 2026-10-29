import { motion, useReducedMotion } from "motion/react";
import { Search, X } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasThemes } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

export type CanvasCreateCommand = {
    id: string;
    label: string;
    icon: ReactNode;
    badge?: string;
    disabledReason?: string;
    section: "node" | "workflow" | "project" | "resource";
    onClick: () => void;
};

export function CanvasCreateMenu({ commands, layout = "grid", title = "添加节点", showSearch = layout === "list", showSectionTitles = true, showResources = true }: { commands: CanvasCreateCommand[]; layout?: "grid" | "list"; title?: string; showSearch?: boolean; showSectionTitles?: boolean; showResources?: boolean }) {
    const theme = canvasThemes[useActiveTheme()];
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleCommands = useMemo(() => {
        const filtered = normalizedQuery
            ? commands.filter((command) => `${command.label} ${command.badge || ""}`.toLocaleLowerCase().includes(normalizedQuery))
            : commands;
        // LibTV's default list keeps the primary creation/import flow compact.
        // Advanced node types remain available through the same search box, so
        // hiding them here changes presentation without removing capability.
        if (layout === "list" && !normalizedQuery) {
            const advancedLabels = new Set(["绘图", "文件夹", "批量创作表"]);
            return filtered.filter((command) => !advancedLabels.has(command.label));
        }
        return filtered;
    }, [commands, layout, normalizedQuery]);
    const projectCommands = visibleCommands.filter((command) => command.section === "project");
    const nodeCommands = visibleCommands.filter((command) => command.section === "node");
    const workflowCommands = visibleCommands.filter((command) => command.section === "workflow");
    const resourceCommands = visibleCommands.filter((command) => command.section === "resource");

    return (
        <div>
            <header className="flex min-h-7 items-center justify-between gap-2 border-b pb-2" style={{ borderColor: theme.toolbar.border }}>
                <h2 className="font-semibold leading-none" style={{ fontSize: "var(--fs-caption)" }}>{title}</h2>
                {layout !== "list" && projectCommands.map((command) => (
                    <button
                        key={command.id}
                        type="button"
                        data-onboarding={command.label === "图片" ? "image-option" : undefined}
                        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-[var(--dock-item-radius)] px-1.5 font-medium outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/8 [&_svg]:size-3"
                        style={{ color: theme.node.muted, fontSize: "var(--fs-tiny)", "--tw-ring-color": theme.node.muted } as CSSProperties}
                        title={command.label}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={command.onClick}
                    >
                        {command.icon}
                        <span className="whitespace-nowrap">{command.label}</span>
                    </button>
                ))}
                {layout === "list" && showSearch ? (
                    <button
                        type="button"
                        className="ml-auto grid size-6 shrink-0 place-items-center rounded-[var(--dock-item-radius)] opacity-65 transition-opacity hover:opacity-100 focus-visible:ring-2"
                        style={{ color: theme.node.muted, "--tw-ring-color": theme.node.muted } as CSSProperties}
                        aria-label={searchOpen ? "关闭节点搜索" : "搜索节点"}
                        title={searchOpen ? "关闭节点搜索" : "搜索节点"}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setQuery(""); }}
                    >
                        {searchOpen ? <X className="size-3.5" /> : <Search className="size-3.5" />}
                    </button>
                ) : null}
            </header>

            {layout === "list" && searchOpen ? (
                <div className="mt-2 flex h-7 items-center gap-1.5 rounded-[var(--dock-item-radius)] border px-2" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}>
                    <Search className="size-3.5 shrink-0 opacity-50" />
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setSearchOpen(false); } }}
                        className="min-w-0 flex-1 bg-transparent text-[var(--fs-tiny)] outline-none placeholder:opacity-45"
                        style={{ color: theme.node.text }}
                        placeholder="搜索节点"
                        aria-label="搜索节点"
                    />
                </div>
            ) : null}

            {showSectionTitles ? <MenuSection title="创作节点" color={theme.node.muted} /> : null}
            {layout === "list" ? <CanvasCreateCommandList commands={nodeCommands} /> : <CanvasCreateCommandGrid commands={nodeCommands} variant="node" />}

            {layout !== "list" && workflowCommands.length ? (
                <>
                    <MenuSection title="工作流" color={theme.node.muted} spaced />
                    <CanvasCreateCommandGrid commands={workflowCommands} variant="workflow" />
                </>
            ) : null}

            {showResources ? <>
                <MenuSection title="导入资源" color={theme.node.muted} spaced />
                {layout === "list" ? <CanvasCreateCommandList commands={resourceCommands} /> : <CanvasCreateCommandGrid commands={resourceCommands} variant="compact" />}
            </> : null}
        </div>
    );
}

function CanvasCreateCommandList({ commands }: { commands: CanvasCreateCommand[] }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <div className="grid gap-0.5">
            {commands.map((command) => (
                    <button
                        key={command.id}
                        data-onboarding={command.label === "图片" ? "image-option" : undefined}
                        type="button"
                        disabled={Boolean(command.disabledReason)}
                        aria-disabled={Boolean(command.disabledReason)}
                        aria-description={command.disabledReason}
                        className={cn("group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors focus-visible:ring-2", command.disabledReason ? "cursor-not-allowed opacity-40 grayscale" : "hover:bg-white/[.08]")}
                        style={{ color: theme.node.text, "--tw-ring-color": theme.toolbar.border } as CSSProperties}
                        title={command.disabledReason ? `${command.label}：${command.disabledReason}` : command.label}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => { if (!command.disabledReason) command.onClick(); }}
                >
                    <span className="grid size-5 shrink-0 place-items-center opacity-80 [&_svg]:size-4">{command.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{command.label}</span>
                    {command.badge ? <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold opacity-70">{command.badge}</span> : null}
                </button>
            ))}
        </div>
    );
}

function CanvasCreateCommandGrid({ commands, variant }: { commands: CanvasCreateCommand[]; variant: "node" | "compact" | "workflow" }) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();

    return (
        <div className={cn("grid gap-1", variant === "node" ? "grid-cols-4" : variant === "workflow" ? "grid-cols-1" : "grid-cols-2")}>
            {commands.map((command) => (
                <motion.button
                    data-onboarding={command.label === "图片" ? "image-option" : undefined}
                    key={command.id}
                    type="button"
                    disabled={Boolean(command.disabledReason)}
                    aria-disabled={Boolean(command.disabledReason)}
                    aria-description={command.disabledReason}
                    whileHover={reducedMotion ? undefined : { y: -1 }}
                    whileTap={reducedMotion ? undefined : { scale: 0.98 }}
                    transition={aceternityMotion.spring.dock}
                    className={cn(
                        "group min-w-0 overflow-hidden border border-black/10 bg-white/70 outline-none transition-colors focus-visible:ring-2 dark:border-white/10 dark:bg-white/[.04]",
                        command.disabledReason ? "cursor-not-allowed opacity-40 grayscale" : "hover:border-black/20 hover:bg-black/5 dark:hover:border-white/20 dark:hover:bg-white/8",
                        variant === "node"
                            ? "flex h-[var(--canvas-create-node-height)] flex-col items-start justify-between rounded-[var(--dock-item-radius)] px-2 py-2 text-left"
                            : variant === "workflow"
                                ? "flex h-[var(--canvas-create-resource-height)] items-center justify-start gap-2 rounded-[var(--dock-item-radius)] px-2 text-left"
                                : "flex h-[var(--canvas-create-resource-height)] items-center justify-center gap-1.5 rounded-[var(--dock-item-radius)] px-2 text-center",
                    )}
                    style={{ color: theme.node.text, "--tw-ring-color": theme.toolbar.border } as CSSProperties}
                    title={command.disabledReason ? `${command.label}：${command.disabledReason}` : command.label}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => { if (!command.disabledReason) command.onClick(); }}
                >
                    {variant === "node" ? (
                        <>
                            <span className="flex w-full min-w-0 items-center justify-between gap-1">
                                <span className="grid size-6 shrink-0 place-items-center opacity-65 transition-opacity group-hover:opacity-100 [&_svg]:size-5">{command.icon}</span>
                                {command.badge ? <span className="shrink-0 font-medium leading-none" style={{ color: theme.node.muted, fontSize: "var(--fs-tiny)" }}>{command.badge}</span> : null}
                            </span>
                            <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap font-medium leading-none" style={{ fontSize: "var(--fs-label)" }}>{command.label}</span>
                        </>
                    ) : (
                        <>
                            <span className="grid size-4 shrink-0 place-items-center opacity-65 transition-opacity group-hover:opacity-100 [&_svg]:size-3.5">{command.icon}</span>
                            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium leading-none" style={{ fontSize: "var(--fs-label)" }}>{command.label}</span>
                        </>
                    )}
                </motion.button>
            ))}
        </div>
    );
}

function MenuSection({ title, color, spaced = false }: { title: string; color: string; spaced?: boolean }) {
    return <h3 className="mb-1 mt-2 px-1 font-medium leading-none" style={{ color, fontSize: "var(--fs-tiny)", marginTop: spaced ? "var(--space-4)" : "var(--space-2)" }}>{title}</h3>;
}
