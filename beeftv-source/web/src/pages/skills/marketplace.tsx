import { App, Alert, Button, Input, Select, Skeleton, Tabs, Tag } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { AppModal } from "@/components/ui/product/app-modal";
import { addSkill, deleteSkill, getSkill, listSkills, removeSkill, type Skill } from "@/services/api/skills";
import { forkSkill, getInstalledVersions, getMarketRelease, installMarketRelease, rollbackSkill, searchSkillMarket, type InstalledVersion, type MarketItem, type MarketRelease } from "@/services/api/skill-market";
import { SkillEditorDrawer } from "./skill-editor-drawer";
import { SkillInstallModal } from "./skill-install-modal";
import { SkillDetailModal } from "./skill-detail-drawer";
import { SkillPublishingPanel } from "./publishing-panel";
import { MarketFilePreview } from "./market-file-preview";
import { MarketReviewSummary } from "./market-review-summary";
import { capabilityOptions, requirementLabel } from "./market-copy";
import "./marketplace.css";

export default function SkillMarketplace() {
    const { message, modal } = App.useApp();
    const [params, setParams] = useSearchParams();
    const tab = ["market", "mine", "publish"].includes(params.get("tab") || "") ? params.get("tab")! : "market";
    const [items, setItems] = useState<MarketItem[]>([]);
    const [local, setLocal] = useState<Skill[]>([]);
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    const [busy, setBusy] = useState(false);
    const [release, setRelease] = useState<MarketRelease | null>(null);
    const [detail, setDetail] = useState<Skill | null>(null);
    const [edit, setEdit] = useState<Skill | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [installOpen, setInstallOpen] = useState(false);
    const [versions, setVersions] = useState<{ skill: Skill; items: InstalledVersion[] } | null>(null);
    const [versionId, setVersionId] = useState("");
    const reload = useCallback(() => setRevision(n => n + 1), []);
    const changeTab = (next: string) => { setParams({ tab: next }); setPage(1); setQuery(""); };
    useEffect(() => {
        if (tab === "publish") return;
        let stale = false;
        setLoading(true); setError("");
        const timer = setTimeout(() => {
            const work = tab === "market"
                ? searchSkillMarket(query, page).then(value => { if (!stale) { setItems(value.items || []); setTotal(value.total); } })
                : listSkills({ scope: "mine", page, pageSize: 20, search: query }).then(value => { if (!stale) { setLocal(value.skills); setTotal(value.totalCount); } });
            void work.catch(e => { if (!stale) setError(e.message || "暂时无法读取技能"); }).finally(() => { if (!stale) setLoading(false); });
        }, 200);
        return () => { stale = true; clearTimeout(timer); };
    }, [tab, page, query, revision]);
    useEffect(() => {
        const skillId = params.get("skillId"), releaseId = params.get("releaseId");
        if (!skillId || !releaseId) return;
        let stale = false;
        setBusy(true); setRelease(null);
        void getMarketRelease(skillId, releaseId).then(value => { if (!stale) setRelease(value); })
            .catch(e => { if (!stale) message.error(e.message || "该技能版本暂时不可用"); })
            .finally(() => { if (!stale) setBusy(false); });
        return () => { stale = true; };
    }, [params, message]);
    const action = async (work: () => Promise<unknown>, done: string) => {
        setBusy(true);
        try { await work(); message.success(done); reload(); } catch (e) { message.error(e instanceof Error ? e.message : "操作未完成"); } finally { setBusy(false); }
    };
    const openLocal = async (skill: Skill) => action(async () => { setDetail((await getSkill(skill.skillId)).skill); }, "已读取技能文件");
    const openEditor = (skill?: Skill) => { setDetail(null); setEdit(skill || null); setEditorOpen(true); };
    const openRelease = (skillId: string, releaseId: string) => setParams({ tab: "market", skillId, releaseId });
    const deleteLocal = (skill: Skill) => modal.confirm({ title: `删除本机的“${skill.skillName}”？`, content: "本机技能文件和历史版本会被删除。公开市场中的版本不会改变。", okText: "删除本机技能", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await deleteSkill(skill.skillId); setDetail(null); reload(); } });
    const showVersions = async (skill: Skill) => action(async () => { const value = await getInstalledVersions(skill.skillId); setVersions({ skill, items: value.versions }); setVersionId(skill.versionId); }, "已读取本机版本");
    const install = () => { if (release) void action(async () => { await installMarketRelease(release.skillId, release.releaseId); setRelease(null); changeTab("mine"); }, "已安装，可在画布助手中选择使用"); };
    return <WorkspacePage className="skill-market-page">
        <PageHeader title="技能" description="把创作方法带进助手。安装和私人改写无需审核，公开分享时再投稿。" actions={<><Button onClick={() => openEditor()}>创建技能</Button><Button onClick={() => setInstallOpen(true)}>导入文件</Button></>} />
        <Tabs activeKey={tab} onChange={changeTab} items={[{ key: "market", label: "技能市场" }, { key: "mine", label: "我的技能" }, { key: "publish", label: "我的投稿" }]} />
        {tab === "publish" ? <SkillPublishingPanel planId={params.get("planId") || undefined} /> : <>
            <div className="skill-market-toolbar"><Input.Search aria-label="搜索技能" placeholder="搜索名称或用途" allowClear value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /><Button onClick={reload}>刷新</Button></div>
            {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={reload}>重试</Button>} /> : loading ? <Skeleton active paragraph={{ rows: 6 }} /> : <>
                {tab === "market" ? items.map(item => <article className="skill-market-row" key={`${item.skillId}/${item.releaseId}`}>
                    <div className="skill-market-copy"><h2>{item.name} <span>{item.versionLabel}</span></h2><p>{item.description}</p><div className="skill-market-meta"><span>{item.author}</span><span>{item.license}</span><span>{item.verification === "tested" ? "有实测记录" : "效果尚未验证"}</span></div>{item.compatibility?.status === "unsupported" ? <p className="skill-market-warning">当前环境不满足：{item.compatibility.reasons?.join("、")}</p> : null}</div>
                    <Button onClick={() => openRelease(item.skillId, item.releaseId)} loading={busy}>查看与安装</Button>
                </article>) : local.map(skill => <article className="skill-market-row" key={skill.skillId}>
                    <div className="skill-market-copy"><h2>{skill.skillName} <span>{skill.version}</span> {!skill.isAdded ? <Tag>已停用</Tag> : null}</h2><p>{skill.description}</p><div className="skill-market-meta"><span>{skill.sourceType === "market" ? "市场固定版本" : "本机技能"}</span><span>{skill.fileCount} 个文件</span></div>
                        <div className="skill-market-actions"><Button size="small" onClick={() => void openLocal(skill)}>查看文件</Button><Button size="small" disabled={busy} onClick={() => void action(() => skill.isAdded ? removeSkill(skill.skillId) : addSkill(skill.skillId), skill.isAdded ? "已停用，不再供助手选择" : "已启用")}>{skill.isAdded ? "停用" : "启用"}</Button>
                            {skill.sourceType === "market" ? <><Button size="small" onClick={() => { changeTab("market"); setQuery(skill.skillName); }}>检查更新</Button><Button size="small" onClick={() => void showVersions(skill)}>历史版本</Button><Button size="small" onClick={() => void action(async () => openEditor((await forkSkill(skill.skillId)).skill), "已创建私人副本")}>私人改写</Button></> : <><Button size="small" onClick={() => void action(async () => openEditor((await getSkill(skill.skillId)).skill), "已读取技能")}>编辑</Button><Button size="small" onClick={() => setParams({ tab: "publish", skillId: skill.skillId })}>准备投稿</Button></>}
                            {skill.isOwner ? <Button size="small" danger onClick={() => deleteLocal(skill)}>删除</Button> : null}</div>
                    </div>
                </article>)}
                {total === 0 ? <p className="skill-market-empty">{tab === "mine" ? "还没有技能。可以从市场安装，或导入自己的 SKILL.md。" : "没有找到匹配的技能。"}</p> : null}
                <div className="skill-market-actions"><Button disabled={page <= 1} onClick={() => setPage(n => n - 1)}>上一页</Button><span>第 {page} 页 · 共 {total} 项</span><Button disabled={page * 20 >= total} onClick={() => setPage(n => n + 1)}>下一页</Button></div>
                {tab === "mine" ? <p className="skill-market-help">打开项目画布，在助手输入框选择“技能”，再选本次要用的版本。使用过程中产生的模型费用按你的模型配置计费。<Link to="/project">打开项目</Link></p> : null}
            </>}
        </>}
        <AppModal open={Boolean(release)} title="检查技能并安装" onCancel={() => { setRelease(null); setParams({ tab: "market" }); }} footer={<Button type="primary" loading={busy} disabled={release?.requirements.some(value => !capabilityOptions.some(item => item.value === value))} onClick={install}>安装此版本</Button>} width={720}>
            {release ? <div className="skill-market-preview">
                <h2>{release.name} · {release.versionLabel}</h2><p>{release.description}</p><p>作者：{release.author} · 许可：{release.license}</p>
                <p>使用条件：{release.requirements.length ? release.requirements.map(requirementLabel).join("、") : "没有额外工具要求"}</p>{release.requirementNotes ? <p>{release.requirementNotes}</p> : null}
                {release.requirements.some(value => value.startsWith("model.")) ? <Alert type="info" title="使用前需要在模型配置中选择支持所需理解能力的模型。安装不代表这些条件已满足。" /> : null}
                <p>模型与费用请按技能说明确认。安装只保存文件，使用时由你选择模型。</p><p>安装后不会自动运行，也不会替你切换模型。后续更新需要再次确认。</p>
                <h3>包含的文件</h3><ul>{release.files.map(file => <li key={file.path}>{file.path} · {file.size} 字节</li>)}</ul><p className="skill-market-meta">内容摘要：{release.contentHash}</p>
                <MarketReviewSummary review={release.review} /><MarketFilePreview key={release.releaseId} skillId={release.skillId} releaseId={release.releaseId} />
            </div> : null}
        </AppModal>
        <AppModal open={Boolean(versions)} title="恢复本机历史版本" onCancel={() => setVersions(null)} onOk={() => { if (versions) void action(async () => { await rollbackSkill(versions.skill.skillId, versionId); setVersions(null); }, "已恢复指定版本"); }} okText="恢复此版本" okButtonProps={{ disabled: !versions || versionId === versions.skill.versionId, loading: busy }}>
            <p>恢复后新对话可选择此版本。已有对话保留原先选定的版本。</p><Select className="w-full" value={versionId} onChange={setVersionId} options={versions?.items.map(v => ({ value: v.id, label: `${v.versionLabel} · ${v.createdAt.slice(0, 10)}${v.id === versions.skill.versionId ? "（当前）" : ""}` }))} />
        </AppModal>
        <SkillDetailModal fileOnly skill={detail} loading={false} mutating={busy} categories={[]} onClose={() => setDetail(null)} onEdit={openEditor} onAdd={() => {}} onLike={() => {}} onSync={() => {}} />
        <SkillEditorDrawer open={editorOpen} skill={edit} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); changeTab("mine"); reload(); }} />
        <SkillInstallModal open={installOpen} onClose={() => setInstallOpen(false)} onManualCreate={() => { setInstallOpen(false); openEditor(); }} onInstalled={() => { setInstallOpen(false); changeTab("mine"); reload(); }} />
    </WorkspacePage>;
}
