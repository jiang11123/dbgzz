import { ArrowUp, Hand, ImagePlus, Layers3, Plus, Search, Sparkles, Users, WandSparkles, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { WorkspacePage } from "@/components/layout/workspace-page";

type ShowcaseCard = {
    slug: string;
    category: string;
    title: string;
    description: string;
    image: string;
    views: string;
    author: string;
};

const showcaseCards: ShowcaseCard[] = [
    { slug: "xianxia-drama-planner", category: "短剧漫画", title: "东方巨构美学短剧", description: "一站式生成东方巨构美学短剧", image: "/short-drama-styles/ink-narrative.jpg", views: "4.4k", author: "鲍鱼chill" },
    { slug: "oriental-aesthetic-film", category: "专业影视", title: "仙侠氛围美学短片", description: "仙侠氛围美学短片", image: "/short-drama-styles/fantasy-3d.jpg", views: "2.3k", author: "鲍鱼chill" },
    { slug: "dreamcore-generator", category: "通用技能", title: "梦核美学", description: "从概念到成片一体化创作梦核视觉短片", image: "/short-drama-styles/nature-healing.jpg", views: "1.3k", author: "鲍鱼chill" },
    { slug: "a24-cinematic-aesthetic", category: "专业影视", title: "A24电影美学", description: "高级怪诞电影美学，以作者视角，用粗粝真实的镜头语言", image: "/short-drama-styles/real-life.jpg", views: "1.4k", author: "鲍鱼chill" },
    { slug: "pop-music-video", category: "音乐MV", title: "POP MV", description: "聚焦国际一线流行音乐MV创作体系，一句话自动生成", image: "/short-drama-styles/cyberpunk-neon.jpg", views: "2.6k", author: "鲍鱼chill" },
    { slug: "beauty-blogger-reviewer", category: "自媒体创作", title: "真实感美妆UGC产品种草", description: "一键把美妆卖点变成可见证据与自然口播", image: "/short-drama-styles/urban-live-action.jpg", views: "2.1k", author: "刘不住Wa..." },
];

const filters = ["推荐", "专业影视", "商业广告", "短剧漫画", "动漫游戏", "音乐MV", "自媒体创作", "通用技能", "发现"];

export default function SkillsReferencePage() {
    const navigate = useNavigate();
    const [activeFilter, setActiveFilter] = useState("推荐");
    const [activeTab, setActiveTab] = useState("Skill");
    const [query, setQuery] = useState("");
    const [prompt, setPrompt] = useState("");
    const [submitted, setSubmitted] = useState(false);
    const visibleCards = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        return showcaseCards.filter((card) => {
            const matchesQuery = !normalized || `${card.title}${card.description}${card.author}`.toLowerCase().includes(normalized);
            const matchesCategory = activeFilter === "推荐" || card.category === activeFilter;
            return matchesQuery && matchesCategory;
        });
    }, [activeFilter, query]);

    return (
        <WorkspacePage fluid scroll className="reference-skills-page bg-[#121212] text-white">
            <div className="mx-auto min-h-full w-full max-w-[1680px] px-4 pb-16 pt-7 sm:px-7 lg:px-14 xl:px-16">
                <section className="relative overflow-hidden rounded-[28px] border border-white/[.07] bg-[#151515] px-4 pb-7 pt-9 sm:px-10 sm:pt-12 lg:px-16">
                    <div className="pointer-events-none absolute inset-0 opacity-45 [background-image:radial-gradient(rgba(255,255,255,.16)_1px,transparent_1px)] [background-size:14px_14px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
                    <div className="relative mx-auto max-w-[1100px] text-center">
                        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/[.08] px-3 py-1 text-xs text-cyan-200">
                            <Sparkles className="size-3.5" /> 创作灵感空间
                        </div>
                        <h1 className="text-balance text-3xl font-medium tracking-[-.05em] text-white sm:text-4xl lg:text-[42px]">一个 Skill，一部作品</h1>
                        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/40">把灵感交给 Skill，让复杂的创作流程变成一条清晰的作品路径。</p>

                        <div className="mx-auto mt-9 overflow-hidden rounded-[22px] border border-white/[.12] bg-[#202020] text-left shadow-[0_20px_60px_rgba(0,0,0,.22)]">
                            <textarea
                                value={prompt}
                                onChange={(event) => { setPrompt(event.target.value); setSubmitted(false); }}
                                className="min-h-[148px] w-full resize-none bg-transparent px-5 py-5 text-sm leading-6 text-white outline-none placeholder:text-white/30 sm:px-6"
                                placeholder="请输入你的创作灵感，或从下方挑选一个 Skill 开始"
                                aria-label="创作灵感"
                            />
                            <div className="flex items-center justify-between px-4 pb-4 sm:px-5">
                                <div className="flex items-center gap-4 text-white/50">
                                    <button type="button" className="transition hover:text-white" aria-label="添加附件"><Plus className="size-6" strokeWidth={1.5} /></button>
                                    <button type="button" className="transition hover:text-white" aria-label="选择素材"><Layers3 className="size-[19px]" strokeWidth={1.6} /></button>
                                    <button type="button" className="transition hover:text-white" aria-label="添加图片"><ImagePlus className="size-[19px]" strokeWidth={1.6} /></button>
                                    <button type="button" className="transition hover:text-white" aria-label="开启灵感模式"><Hand className="size-[19px]" strokeWidth={1.6} /></button>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSubmitted(true)}
                                    className={`grid size-11 place-items-center rounded-full transition ${submitted ? "bg-cyan-400 text-[#071116]" : "bg-white/[.08] text-white/35 hover:bg-cyan-400 hover:text-[#071116]"}`}
                                    aria-label="开始创作"
                                >
                                    <ArrowUp className="size-5" />
                                </button>
                            </div>
                        </div>
                        {submitted ? <p className="mt-3 text-xs text-cyan-300/80">灵感已提交，正在为你准备创作空间…</p> : null}
                    </div>
                </section>

                <section className="mt-12">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                        <div className="flex items-center gap-7 text-xl font-medium tracking-[-.03em]">
                            {["Skill", "收藏", "我的"].map((tab) => <button key={tab} type="button" className={activeTab === tab ? "text-white" : "text-white/25 transition hover:text-white/70"} onClick={() => setActiveTab(tab)}>{tab}</button>)}
                        </div>
                        <label className="flex h-11 w-full items-center gap-3 rounded-full border border-white/[.14] bg-white/[.02] px-4 text-white/40 transition focus-within:border-cyan-300/50 lg:max-w-[390px]">
                            <Search className="size-[19px]" />
                            <input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30" placeholder="搜索 Skill" />
                        </label>
                    </div>

                    <div className="mt-6 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
                        {filters.map((filter) => <button key={filter} type="button" onClick={() => setActiveFilter(filter)} className={`shrink-0 rounded-xl border px-4 py-2 text-sm transition ${activeFilter === filter ? "border-white/[.18] bg-white/[.12] text-white" : "border-white/[.08] bg-transparent text-white/45 hover:border-white/[.16] hover:text-white"}`}>{filter}</button>)}
                    </div>

                    <div className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                        {visibleCards.map((card) => <ShowcaseCardView key={card.title} card={card} onUse={() => navigate(`/create?skill=${encodeURIComponent(card.slug)}`)} />)}
                    </div>
                    {!visibleCards.length ? <div className="rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-white/40">没有找到匹配的 Skill</div> : null}
                </section>
            </div>
            <div className="fixed bottom-5 right-5 grid size-12 place-items-center rounded-full border border-white/10 bg-[#252525] text-white/80 shadow-xl"><Zap className="size-5" /></div>
        </WorkspacePage>
    );
}

function ShowcaseCardView({ card, onUse }: { card: ShowcaseCard; onUse: () => void }) {
    return (
        <article className="group grid min-h-[182px] grid-cols-[42%_1fr] gap-4 rounded-[22px] border border-white/[.08] bg-[#202020] p-4 transition hover:-translate-y-1 hover:border-cyan-300/25 hover:bg-[#252525]">
            <div className="relative min-h-[144px] overflow-hidden rounded-xl bg-black/20">
                <img src={card.image} alt="" className="absolute inset-0 size-full object-cover transition duration-500 group-hover:scale-105" />
                <span className="absolute right-2 top-2 rounded-md bg-black/45 px-2 py-1 text-[11px] text-white/85 backdrop-blur">视频</span>
            </div>
            <div className="flex min-w-0 flex-col py-1">
                <h2 className="truncate text-[17px] font-semibold tracking-[-.03em] text-white">{card.title}</h2>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-white/40">{card.description}</p>
                <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-white/45">
                    <span className="grid size-5 place-items-center rounded-full bg-[#edc96a] text-[10px] text-[#332508]">鲍</span>
                    <span className="truncate">{card.author}</span>
                    <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap"><Users className="size-3.5" /> {card.views}</span>
                </div>
                <button type="button" onClick={onUse} className="mt-3 inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-white px-3 text-xs font-medium transition hover:bg-cyan-300" style={{ color: "#050505" }} aria-label="使用">
                    使用 <WandSparkles className="size-3.5" />
                </button>
            </div>
        </article>
    );
}
