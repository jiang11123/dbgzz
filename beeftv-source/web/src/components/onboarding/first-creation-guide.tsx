import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, GripVertical, HelpCircle, X } from "lucide-react";
import { useOnboardingStore, onboardingSteps } from "@/stores/use-onboarding-store";
import { channelHasGenerationCredential, filterModelsByCapability, isBuiltinBeefAPIChannel, modelOptionsFromChannels, useConfigStore } from "@/stores/use-config-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import "./first-creation-guide.css";

const lessons = [
    { title: "连接算力", description: "点击连接，在浏览器确认授权。" },
    { title: "新建项目", description: "点击侧栏「新建项目」，打开一张新画布。" },
    { title: "添加图片", description: "点击添加按钮，选择「图片」。" },
    { title: "生成图片", description: "选中图片节点，输入描述并生成。" },
    { title: "查看生成历史", description: "刚生成的图片会保存在这里。" },
    { title: "继续创作", description: "打开刚才的项目，继续编辑。" },
];
const sample = "一只穿着黄色雨衣的小狗，站在雨后的街道上，温暖的插画风格。";

export function OnboardingEntry({ compact = false }: { compact?: boolean }) {
    return <button type="button" className={`app-workspace-nav-link first-creation-entry${compact ? " is-collapsed" : ""}`} aria-label="新手引导" title="新手引导" onClick={() => window.dispatchEvent(new Event("beeftv:open-guide"))}>
        <span className="app-workspace-nav-main flex min-w-0 items-center gap-2.5">
            <span className="app-workspace-nav-icon" aria-hidden><HelpCircle className="size-4 shrink-0" strokeWidth={1.8} /></span>
            {!compact && <span className="app-workspace-nav-title truncate">新手引导</span>}
        </span>
    </button>;
}

export function FirstCreationGuide() {
    const guide = useOnboardingStore();
    const config = useConfigStore((state) => state.config);
    const projects = useCanvasStore((state) => state.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const [welcome, setWelcome] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [notice, setNotice] = useState("");
    const [finished, setFinished] = useState(false);
    const [highlight, setHighlight] = useState<{ step: typeof onboardingSteps[number]; rect: DOMRect } | null>(null);
    const nodeStepStartedAt = useRef<number | null>(null);
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
    const step = onboardingSteps[guide.step];
    const project = projects.find((item) => item.id === guide.projectId);
    const node = project?.nodes.find((item) => item.id === guide.nodeId);
    const result = project?.nodes.find((item) => item.type === "image" && item.metadata?.content && (item.id === guide.nodeId || item.metadata?.generatedFromNodeId === guide.nodeId) && (item.metadata?.resultOrigin === "generated" || Boolean(item.metadata?.taskId)));
    const official = config.channels.find(isBuiltinBeefAPIChannel);
    const connected = Boolean(official && channelHasGenerationCredential(official) && filterModelsByCapability(modelOptionsFromChannels([official]), "image", [official]).length);
    const ready = step === "official" ? connected : step === "project" ? Boolean(project) : step === "node" ? Boolean(node) : step === "generate" ? Boolean(result) : step === "assets" ? pathname === "/assets" && new URLSearchParams(search).get("tab") === "history" && Boolean(result) : guide.visitedLibrary && Boolean(project) && pathname === `/canvas/${project?.id}`;

    useEffect(() => {
        if (hydrated && !projects.length && guide.status === "new") setWelcome(true);
    }, [hydrated, projects.length, guide.status]);
    useEffect(() => {
        const open = () => { guide.restart(); setCollapsed(false); setWelcome(true); };
        window.addEventListener("beeftv:open-guide", open);
        return () => window.removeEventListener("beeftv:open-guide", open);
    }, [guide.restart]);
    useEffect(() => { nodeStepStartedAt.current = step === "node" ? Date.now() : null; }, [step]);
    useEffect(() => {
        if (guide.status !== "active") return;
        if (step === "project" || step === "node" || step === "generate") {
            const id = pathname.match(/^\/canvas\/([^/]+)$/)?.[1];
            const created = projects.find((item) => item.id === id && item.createdAt >= (guide.startedAt || ""));
            if (created && created.id !== guide.projectId) { guide.bind({ projectId: created.id, nodeId: undefined, assetId: undefined }); return; }
        }
        const startedAt = nodeStepStartedAt.current;
        if (step === "node" && project && startedAt !== null) {
            const added = [...project.nodes].reverse().find((item) => item.type === "image" && item.metadata?.nodeRole !== "result" && item.createdAt && Date.parse(item.createdAt) >= startedAt);
            if (added && added.id !== guide.nodeId) guide.bind({ nodeId: added.id });
        }
        if (step === "generate" && project && !node) {
            const image = project.nodes.find((item) => item.type === "image" && item.metadata?.nodeRole !== "result")
                || project.nodes.find((item) => item.type === "image" && (item.metadata?.resultOrigin === "generated" || item.metadata?.taskId));
            if (image) guide.bind({ nodeId: image.id });
        }
        if (step === "return" && !guide.visitedLibrary && ["/project", "/canvas", "/projects"].includes(pathname)) guide.bind({ visitedLibrary: true });
    }, [guide.status, step, pathname, search, projects, project, guide.projectId, guide.nodeId]);
    useEffect(() => {
        if (guide.status !== "active" || step !== "node" || !node?.createdAt || nodeStepStartedAt.current === null) return;
        if (Date.parse(node.createdAt) < nodeStepStartedAt.current) return;
        setHighlight(null);
        guide.advance();
    }, [guide.status, step, node, guide.advance]);
    useEffect(() => { setNotice(""); setHighlight(null); setCollapsed(false); }, [guide.step, guide.status]);
    useEffect(() => { const reset = () => setPosition(null); window.addEventListener("resize", reset); return () => window.removeEventListener("resize", reset); }, []);
    useEffect(() => {
        if (guide.status !== "active" || welcome) return;
        const close = (event: KeyboardEvent) => { if (event.key === "Escape") { guide.pause(); setHighlight(null); } };
        window.addEventListener("keydown", close);
        return () => window.removeEventListener("keydown", close);
    }, [guide.status, welcome, guide.pause]);
    const routeFor = (lesson: typeof step) => {
        const canvas = project ? `/canvas/${project.id}` : "/project";
        return lesson === "official" ? "/settings?section=channels" : lesson === "assets" ? "/assets?tab=history" : lesson === "return" ? "/project" : lesson === "project" ? "/project" : canvas;
    };
    const goToLesson = (lesson: typeof step) => {
        const route = routeFor(lesson);
        if (`${pathname}${search}` !== route) navigate(route);
    };

    useEffect(() => {
        if (guide.status !== "active" || welcome || collapsed) { setHighlight(null); return; }
        let timer: number | null = null;
        let settleTimer: number | null = null;
        let lastTarget: HTMLElement | null = null;
        const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((element) => { const rect = element.getBoundingClientRect(); return rect.width > 2 && rect.height > 2; }) || null;
        const update = () => {
            timer = null;
            let target: HTMLElement | null = null;
            if (step === "official" && pathname === "/settings") target = connected ? visible('[aria-label="默认生图模型"]') || visible(".model-default-section") : visible('[data-onboarding="official-connect"]') || visible('[data-onboarding="official-channel"]');
            if (step === "project") target = visible('[title="点击修改画布名称"]') || visible('[aria-label="画布名称"]') || visible('[data-nav-id="new"]') || visible('[aria-label="新建画布创作"]');
            if (step === "node" && !ready) target = visible('[data-onboarding="image-option"]') || visible('[aria-label="添加节点"]') || visible('[data-onboarding="canvas-tools"]') || visible('[data-nav-id="new"]');
            if (step === "generate") {
                const prompt = visible('[aria-label="图片提示词"]');
                const hasPrompt = prompt && ((prompt as HTMLTextAreaElement).value || prompt.textContent || "").trim();
                target = hasPrompt ? visible('.canvas-node-composer-submit') : prompt;
                target ||= guide.nodeId ? visible(`[data-node-id="${CSS.escape(guide.nodeId)}"]`) : visible('[aria-label="添加节点"]') || visible('[data-nav-id="new"]');
            }
            if (step === "assets" && pathname === "/assets" && new URLSearchParams(search).get("tab") === "history") {
                const taskId = result?.metadata?.taskId;
                target = taskId ? visible(`[data-onboarding-task-id="${CSS.escape(taskId)}"]`) : null;
                target ||= visible(".generation-history-page .assets-library-hero") || visible(".generation-history-type-tabs");
            }
            if (step === "return") target = guide.projectId ? visible(`[data-onboarding-project="${CSS.escape(guide.projectId)}"]`) : visible('[data-nav-id="canvas"]');
            if (target !== lastTarget) {
                if (settleTimer !== null) { window.clearTimeout(settleTimer); settleTimer = null; }
                lastTarget?.classList.remove("is-onboarding-target");
                target?.classList.add("is-onboarding-target");
                if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
                lastTarget = target;
                // The add-node menu enters with a 320ms transform. Its first
                // bounding box is transient, so measure the image option once
                // after the motion ends instead of observing every style frame.
                if (target?.matches('[data-onboarding="image-option"]')) {
                    settleTimer = window.setTimeout(() => { settleTimer = null; update(); }, 380);
                    return;
                }
            }
            if (settleTimer !== null) return;
            const rect = target?.getBoundingClientRect();
            setHighlight((previous) => {
                if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
                if (previous?.step === step && previous.rect.x === rect.x && previous.rect.y === rect.y && previous.rect.width === rect.width && previous.rect.height === rect.height) return previous;
                return { step, rect };
            });
        };
        const schedule = () => { if (timer === null) timer = window.setTimeout(update, 60); };
        // Canvas nodes and sidebar motion update style attributes each frame.
        // Observing those writes made the guide repaint continuously while a
        // new project was opening. Only mounting/unmounting targets matters.
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("scroll", schedule, true);
        window.addEventListener("resize", schedule);
        document.addEventListener("input", schedule, true);
        update();
        return () => { observer.disconnect(); lastTarget?.classList.remove("is-onboarding-target"); if (timer !== null) window.clearTimeout(timer); if (settleTimer !== null) window.clearTimeout(settleTimer); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("input", schedule, true); };
    }, [step, guide.status, welcome, collapsed, pathname, search, connected, ready, guide.nodeId, guide.projectId, result?.metadata?.taskId]);
    const dismiss = () => { setWelcome(false); guide.pause(); };
    const advance = (skip = false) => { guide.advance(skip); if (step === "return") setFinished(true); else goToLesson(onboardingSteps[guide.step + 1]); };
    const back = () => { guide.back(); goToLesson(onboardingSteps[guide.step - 1]); };
    const highlightRect = highlight?.step === step ? highlight.rect : null;
    const spotlight = highlightRect && guide.status === "active" && !collapsed && !(step === "node" && ready) && {
        left: Math.max(0, highlightRect.left - 8),
        top: Math.max(0, highlightRect.top - 8),
        right: Math.min(window.innerWidth, highlightRect.right + 8),
        bottom: Math.min(window.innerHeight, highlightRect.bottom + 8),
    };
    return <>
        <AppModal open={finished} transitionName="" maskTransitionName="" title="引导已结束" onCancel={() => setFinished(false)} footer={<Button type="primary" onClick={() => setFinished(false)}>继续使用 BeefTV</Button>} width={420}>
            <p className="first-creation-intro">随时从侧栏重新打开引导。</p>
        </AppModal>
        <AppModal open={welcome} transitionName="" maskTransitionName="" title="完成第一次创作" onCancel={dismiss} footer={null} width={420} destroyOnHidden>
            <p className="first-creation-intro">跟着高亮操作，点击引导卡上的箭头按钮切换步骤。</p>
            <div className="first-creation-actions"><Button onClick={dismiss}>稍后</Button><Button type="primary" onClick={() => { guide.restart(); goToLesson(onboardingSteps[0]); setWelcome(false); setCollapsed(false); }}>开始</Button></div>
        </AppModal>
        {guide.status === "active" && !welcome && <aside className={`first-creation-guide${/^\/canvas\/[^/]+/.test(pathname) ? " is-canvas" : ""}${collapsed ? " is-collapsed" : ""}`} style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined} aria-label="新手引导" data-step={step} data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <div className="first-creation-heading"><button type="button" className="first-creation-move" aria-label="移动引导卡，可拖动或使用方向键" title="拖动以移动引导" onPointerDown={(event) => { const bounds = event.currentTarget.closest("aside")!.getBoundingClientRect(); setDrag({ x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top }); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag) return; const bounds = event.currentTarget.closest("aside")!.getBoundingClientRect(); setPosition({ x: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, drag.left + event.clientX - drag.x)), y: Math.max(8, Math.min(window.innerHeight - bounds.height - 8, drag.top + event.clientY - drag.y)) }); }} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onKeyDown={(event) => { const delta: Record<string, [number, number]> = { ArrowUp: [0, -20], ArrowDown: [0, 20], ArrowLeft: [-20, 0], ArrowRight: [20, 0] }; if (!delta[event.key]) return; event.preventDefault(); const bounds = event.currentTarget.closest("aside")!.getBoundingClientRect(); setPosition({ x: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, bounds.left + delta[event.key][0])), y: Math.max(8, Math.min(window.innerHeight - bounds.height - 8, bounds.top + delta[event.key][1])) }); }}><GripVertical size={15} /></button><button type="button" className="first-creation-expand" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}><span>{collapsed ? lessons[guide.step].title : `新手引导 · ${guide.step + 1} / ${lessons.length}`}</span><ChevronDown size={15} /></button><button type="button" className="first-creation-close" aria-label="关闭引导" title="关闭引导" onClick={() => guide.pause()}><X size={17} /></button></div>
            {!collapsed && <><h2>{lessons[guide.step].title}{ready && <Check size={16} className="first-creation-check" aria-label="已完成" />}</h2><p>{step === "official" && connected ? "已连接，选择你要使用的默认模型。" : step === "project" && project ? "点击项目名称，为它起个名字。" : lessons[guide.step].description}</p>
                {notice && <p role="status">{notice}</p>}
                <div className="first-creation-footer"><div className="first-creation-secondary">
                    {step === "generate" && <button type="button" className="first-creation-copy" title={sample} onClick={() => { void navigator.clipboard.writeText(sample).then(() => setNotice("已复制，粘贴到提示词输入框。")).catch(() => setNotice("复制失败，请手动输入描述。")); }}><Copy size={13} />示例提示词</button>}
                    {step === "generate" && <small>生成按模型计费</small>}
                </div><div className="first-creation-navigation"><button type="button" disabled={guide.step === 0} aria-label="上一步" title="上一步" onClick={back}><ChevronLeft size={18} /></button><button type="button" className="is-next" aria-label={step === "return" ? "结束引导" : "下一步"} title={step === "return" ? "结束引导" : "下一步"} onClick={() => advance(!ready)}><ChevronRight size={18} /></button></div></div>
            </>}
        </aside>}
        {spotlight && <>
            <div className="first-creation-dim" aria-hidden style={{ inset: "0 0 auto 0", height: spotlight.top }} />
            <div className="first-creation-dim" aria-hidden style={{ left: 0, top: spotlight.top, width: spotlight.left, height: spotlight.bottom - spotlight.top }} />
            <div className="first-creation-dim" aria-hidden style={{ right: 0, top: spotlight.top, left: spotlight.right, height: spotlight.bottom - spotlight.top }} />
            <div className="first-creation-dim" aria-hidden style={{ inset: `${spotlight.bottom}px 0 0 0` }} />
            <div className="first-creation-highlight" aria-hidden style={{ left: highlightRect.left - 4, top: highlightRect.top - 4, width: highlightRect.width + 8, height: highlightRect.height + 8 }} />
        </>}
    </>;
}
