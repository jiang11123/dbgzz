import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "antd";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { compatibleModelInGroup, configuredModelDisplayName, groupModelsByDisplayName, modelCompatibilityError, resolveCompatibleModel, type ModelRequirements } from "@/lib/model-selection";
import { cn } from "@/lib/utils";
import { modelDisplayName, modelIcon, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { ModelLogo } from "@/components/model-logo";
import { portraitPriceLines, seedancePortraitLabel, seedancePortraitModel } from "@/lib/seedance-portrait";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    popoverClassName?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    variant?: "default" | "creation";
    requirements?: ModelRequirements;
    showConfiguredModelName?: boolean;
};

export function ModelPicker({
    config,
    value,
    onChange,
    capability,
    className,
    popoverClassName,
    fullWidth = false,
    placeholder = "选择模型",
    onMissingConfig,
    variant = "creation",
    requirements,
    showConfiguredModelName = false,
}: ModelPickerProps) {
    const pickerId = useId();
    // 双保险：即使 store merge 写出非法 theme，这里也兜底到 dark，避免 "reading 'node'" 崩溃
    const rawTheme = useActiveTheme();
    const theme = (canvasThemes[rawTheme as keyof typeof canvasThemes] ?? canvasThemes.dark) as CanvasTheme;
    const [open, setOpen] = useState(false);
    const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
    const [previewedModel, setPreviewedModel] = useState("");
    const [triggerWidth, setTriggerWidth] = useState<number | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const options = useMemo(() => Array.from(new Set(selectableModelsByCapability(config, capability).filter(Boolean))), [capability, config]);
    const optionGroups = useMemo(() => {
        const channelGroups = config.channels
            .map((channel) => ({
                key: channel.id,
                label: channel.name || "未命名渠道",
                models: groupModelsByDisplayName(
                    config,
                    options.filter((model) => resolveModelChannel(config, model).id === channel.id),
                ),
            }))
            .filter((group) => group.models.length);
        // options 已由当前有效渠道重建；任何无法解析渠道的旧值都直接丢弃，
        // 不再显示“其他模型 / 未指定渠道”这种不可用入口。
        return channelGroups;
    }, [config, options]);
    const storedCurrent = value?.trim() || "";
    // 参数档位会在选中模型后由调用方归一到其能力配置，不能因为旧模型留下的参数而禁止切换。
    const selectionRequirements = requirements ? { ...requirements, videoSeconds: undefined, imageSize: undefined, options: undefined } : undefined;
    const resolvedCurrent = resolveCompatibleModel(config, storedCurrent, selectionRequirements) || storedCurrent;
    // 旧画布可能保存过已下架或前端历史内置模型；它们不能重新进入当前可选目录。
    const current = options.includes(resolvedCurrent) ? resolvedCurrent : "";
    const portrait = seedancePortraitModel(current || storedCurrent);
    const portraitQuote = current ? resolveModelChannel(config, current).modelProfiles?.find((item) => item.model === modelOptionName(current))?.videoPricing : undefined;
    const priceLines = portraitPriceLines(portraitQuote);
    const creationVariant = variant === "creation";
    const triggerLabel = current
        ? (creationVariant ? pickerModelDisplayName(config, current, showConfiguredModelName) : pickerModelOptionLabel(config, current, showConfiguredModelName))
        : portrait ? `${seedancePortraitLabel(storedCurrent)}（不可用）` : placeholder;

    useLayoutEffect(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const updateTriggerWidth = () => setTriggerWidth(Math.ceil(trigger.getBoundingClientRect().width));
        updateTriggerWidth();
        const observer = new ResizeObserver(updateTriggerWidth);
        observer.observe(trigger);
        return () => observer.disconnect();
    }, [className, fullWidth, variant, value]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    useEffect(() => {
        if (!open) return;
        // 画布拖拽从 pointerdown 开始，须在捕获阶段关闭 Portal 菜单，避免菜单与触发器分离。
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setOpen(false);
        };
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    }, [open]);

    const setPickerOpen = (nextOpen: boolean) => {
        if (nextOpen && !options.length) onMissingConfig?.();
        if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
        if (nextOpen) {
            setPreviewedModel(current || options[0] || "");
            setActiveGroupKey(null);
        }
        setOpen(nextOpen);
    };
    const focusMenuOption = (last = false) => {
        window.requestAnimationFrame(() => {
            const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
            const target = last ? buttons?.item((buttons?.length || 1) - 1) : buttons?.item(0);
            target?.focus();
        });
    };
    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        setPickerOpen(true);
        focusMenuOption(event.key === "ArrowUp");
    };
    const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
            return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
        if (!buttons.length) return;
        event.preventDefault();
        const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? Math.max(0, activeIndex - 1) : Math.min(buttons.length - 1, activeIndex + 1);
        buttons[nextIndex]?.focus();
    };
    const toggleGroup = (group: (typeof optionGroups)[number]) => {
        if (activeGroupKey === group.key) {
            setActiveGroupKey(null);
            return;
        }
        const groupCurrent = group.models.find((item) => item.models.includes(current));
        setActiveGroupKey(group.key);
        setPreviewedModel(groupCurrent?.models[0] || group.models[0]?.models[0] || "");
    };
    const content = (
        <div
            ref={menuRef}
            data-canvas-no-zoom
            className={cn(
                "canvas-model-picker-menu creation-model-picker-menu max-w-[calc(100vw-24px)]",
                activeGroupKey === null ? "is-brand-list" : "is-model-list",
            )}
            style={
                {
                    background: theme.node.panel,
                    color: theme.node.text,
                    "--canvas-model-picker-trigger-width": triggerWidth ? String(triggerWidth) + "px" : undefined,
                } as CSSProperties
            }
            role="listbox"
            aria-label={placeholder}
            onKeyDown={handleMenuKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {optionGroups.length ? (
                activeGroupKey === null ? (
                    <div className="canvas-model-picker-brands" aria-label="选择模型品牌">
                        {optionGroups.map((group) => {
                            return <button key={group.key} type="button" className="canvas-model-picker-brand" aria-expanded={false} onClick={() => toggleGroup(group)}>
                                <span className="canvas-model-picker-brand-copy"><strong>{group.label}</strong></span>
                                <ChevronDown className="canvas-model-picker-brand-arrow" aria-hidden="true" />
                            </button>;
                        })}
                    </div>
                ) : <div className="canvas-model-picker-two-pane">
                    <div className="canvas-model-picker-brand-rail" aria-label="模型品牌">
                        {optionGroups.map((group) => {
                            return <button key={group.key} type="button" className={cn("canvas-model-picker-brand", activeGroupKey === group.key && "is-active")} aria-expanded={activeGroupKey === group.key} onClick={() => toggleGroup(group)}>
                                <span className="canvas-model-picker-brand-copy"><strong>{group.label}</strong></span>
                                <ChevronDown className="canvas-model-picker-brand-arrow" aria-hidden="true" />
                            </button>;
                        })}
                    </div>
                    {optionGroups.filter((group) => group.key === activeGroupKey).map((group) => <section key={group.key} className="canvas-model-picker-group canvas-model-picker-model-pane min-w-0 overflow-hidden">
                        <div className="canvas-model-picker-options grid min-w-0 gap-1">
                            {group.models.map((modelGroup) => {
                                const selected = modelGroup.models.includes(current);
                                const model = compatibleModelInGroup(config, modelGroup.models, selectionRequirements, selected ? current : undefined);
                                const displayModel = model || (selected ? current : modelGroup.models[0]);
                                const disabledReason = model ? "" : modelCompatibilityError(config, modelGroup.models[0], selectionRequirements) || "当前输入不符合该模型能力";
                                return (
                                    <button
                                        key={modelGroup.key}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        aria-disabled={Boolean(disabledReason)}
                                        disabled={Boolean(disabledReason)}
                                        title={disabledReason || pickerModelOptionLabel(config, displayModel, showConfiguredModelName)}
                                        className={cn("canvas-model-picker-option disabled:cursor-not-allowed disabled:opacity-45", previewedModel === displayModel && "is-previewed")}
                                        style={{ background: selected ? theme.toolbar.activeBg : "transparent", color: theme.node.text }}
                                        onMouseEnter={() => setPreviewedModel(displayModel)}
                                        onFocus={() => setPreviewedModel(displayModel)}
                                        onClick={() => {
                                            if (!model) return;
                                            onChange(model);
                                            setOpen(false);
                                            window.requestAnimationFrame(() => triggerRef.current?.focus());
                                        }}
                                    >
                                        <ModelLabel
                                            config={config}
                                            model={displayModel}
                                            showConfiguredModelName={showConfiguredModelName}
                                        />
                                        {selected ? <Check className="canvas-model-picker-option-check ml-1 shrink-0" style={{ color: theme.node.activeStroke }} /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    </section>)}
                </div>
            ) : (
                <div className="canvas-model-picker-empty" style={{ color: theme.node.muted }}>
                    {emptyModelLabel(config, capability)}
                </div>
            )}
        </div>
    );

    return (
        <div className={cn("flex items-center gap-2", fullWidth ? "w-full min-w-0" : "w-fit max-w-full")} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Popover
                open={open}
                onOpenChange={setPickerOpen}
                trigger="click"
                placement="bottomLeft"
                arrow={false}
                content={content}
                classNames={{
                    root: cn("canvas-model-picker-popover", "creation-model-picker-popover", popoverClassName),
                    container: cn("canvas-composer-popover-surface", "creation-model-picker-surface"),
                    content: "canvas-composer-popover-content",
                }}
            >
                <button
                    ref={triggerRef}
                    type="button"
                    className={cn("canvas-composer-model-picker", fullWidth ? "w-full" : "min-w-36 max-w-full", className)}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-label={triggerLabel}
                    title={current ? pickerModelOptionLabel(config, current, showConfiguredModelName) : placeholder}
                    onKeyDown={handleTriggerKeyDown}
                >
                    <span className="canvas-model-picker-label flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
                    </span>
                    <ChevronDown className={cn("canvas-model-picker-chevron", open && "is-open")} aria-hidden="true" />
                </button>
            </Popover>
            {portrait || priceLines.length > 0 ? <Popover trigger="click" placement="topLeft" content={
                <div className="max-w-[min(26rem,calc(100vw-3rem))] text-xs leading-relaxed" role="note">
                    {priceLines.length ? <><p>视频参考单价</p>{priceLines.map((line) => <p key={line}>{line}</p>)}<p>实际费用见生成账单。素材仍需通过审核。</p></> : <p>价格暂不可用，请刷新模型列表后再生成。</p>}
                </div>
            }>
                <button type="button" className="shrink-0 rounded px-1 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ color: theme.node.muted }} aria-label="视频参考单价" title={priceLines.join("\n") || "价格暂不可用，请刷新模型列表后再生成。"}>
                    {priceLines.length ? "价格" : "价格暂不可用"}
                </button>
            </Popover> : null}
        </div>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability === "image" ? "生图" : capability === "video" ? "视频" : capability === "text" ? "文本" : capability === "audio" ? "音频" : "";
    if (capability && config.models.length) return `暂无支持当前输入的${label}模型`;
    return config.models.length ? `暂无匹配的${label}模型` : "当前没有可用模型，请联系管理员或检查模型配置";
}

function ModelLabel({
    config,
    model,
    showConfiguredModelName,
}: {
    config: AiConfig;
    model: string;
    showConfiguredModelName: boolean;
}) {
    return (
        <span className="canvas-model-picker-option-content flex w-full min-w-0 items-center overflow-hidden">
            <span className="canvas-model-picker-option-name block min-w-0 flex-1 truncate text-[var(--fs-label)] font-medium leading-none">
                {pickerModelDisplayName(config, model, showConfiguredModelName)}
            </span>
        </span>
    );
}

function pickerModelDisplayName(config: AiConfig, model: string, showConfiguredModelName: boolean) {
    return showConfiguredModelName ? configuredModelDisplayName(config, model) : modelDisplayName(config, model);
}

function pickerModelOptionLabel(config: AiConfig, model: string, showConfiguredModelName: boolean) {
    const displayName = showConfiguredModelName ? configuredModelDisplayName(config, model) : modelDisplayName(config, model);
    const channel = resolveModelChannel(config, model);
    return channel.scope === "system" ? displayName : `${displayName}（${channel.name}）`;
}


export function ModelIcon({ config, model, icon }: { config?: AiConfig; model?: string; icon?: string }) {
    return <ModelLogo icon={icon || (config && model ? modelIcon(config, model) : "")} size={14} className="opacity-80" />;
}
