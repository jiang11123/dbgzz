import { Alert, App, Button, Checkbox, Form, Input, Select, Skeleton } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { getSkill, listSkills, type Skill } from "@/services/api/skills";
import { disconnectMarketAuthorization, getMarketAuthorization, listPublishPlans, preparePublication, refreshPublication, startMarketAuthorization, submitPublication, uploadPublication, type MarketAuthorization, type PublishPlan, type SkillMetadata, type PublicationTarget } from "@/services/api/skill-market";
import { canSubmitPublication, capabilityOptions, needsPublicationTargetCorrection, publicationStatus, requirementLabel, unsupportedRequirements } from "./market-copy";

export async function openSkillWebsite(url: string) {
    const binding = getDesktopAppBinding()?.OpenSkillMarketURL;
    if (binding) await binding(url);
    else window.open(url, "_blank", "noopener,noreferrer");
}

export function SkillPublishingPanel({ planId }: { planId?: string }) {
    const { message } = App.useApp();
    const [params, setParams] = useSearchParams();
    const [plans, setPlans] = useState<PublishPlan[]>([]);
    const [selected, setSelected] = useState("");
    const [skills, setSkills] = useState<Skill[]>([]);
    const [auth, setAuth] = useState<MarketAuthorization>({});
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [creating, setCreating] = useState(false);
    const [preparingFrom, setPreparingFrom] = useState<PublishPlan | null>(null);
    const [form] = Form.useForm<Omit<SkillMetadata, "skillId"> & PublicationTarget & { localSkillId: string }>();
    const formRequirements = Form.useWatch("requirements", form) || [];
    const publicationTarget = Form.useWatch("publicationTarget", form);
    const current = plans.find(item => item.planId === selected);
    const website = auth.websiteUrl || "https://beeftv.app/skills";
    const replace = (next: PublishPlan) => { setPlans(items => [next, ...items.filter(item => item.planId !== next.planId)]); setSelected(next.planId); setConfirmed(false); setParams({ tab: "publish", planId: next.planId }); };
    const reload = useCallback(async () => {
        setLoading(true); setError("");
        try {
            const [drafts, installed] = await Promise.all([listPublishPlans(), listSkills({ scope: "created", pageSize: 100 })]);
            setPlans(drafts.items); setSkills(installed.skills);
            setSelected(previous => planId || previous || drafts.items[0]?.planId || "");
        } catch (e) { setError(e instanceof Error ? e.message : "投稿记录读取失败"); }
        finally { setLoading(false); }
    }, [planId]);
    useEffect(() => { void reload(); void getMarketAuthorization().then(setAuth).catch(() => setAuth({ connected: false })); }, [reload]);
    useEffect(() => {
        const localSkillId = params.get("skillId");
        if (localSkillId) {
            const skill = skills.find(item => item.skillId === localSkillId);
            form.setFieldsValue({ localSkillId, name: skill?.skillName, description: skill?.description, versionLabel: skill?.version || "1.0.0", publicationTarget: skill?.marketRelease || skill?.originalSkillId ? undefined : "new" });
            setCreating(true);
        }
    }, [params, form, skills]);
    useEffect(() => { setConfirmed(false); }, [selected, current?.preview?.previewDigest]);
    const run = async (work: () => Promise<unknown>) => {
        setBusy(true); setError("");
        try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "操作未完成，请保留此草稿后重试"); } finally { setBusy(false); }
    };
    const makePlan = async () => {
        const values = await form.validateFields();
        const skill = skills.find(item => item.skillId === values.localSkillId);
        if (!skill) return;
        if (preparingFrom && skill.skillId === preparingFrom.skillId && skill.versionId !== preparingFrom.versionId) {
            setError("本机技能已更新，原稿仍保留。请从“我的技能”检查当前文件后重新准备投稿。");
            return;
        }
        await run(async () => {
            const { localSkillId, publicationTarget, marketSkillId, ...fields } = values;
            const metadata = { ...preparingFrom?.metadata, ...fields, name: fields.name || skill.skillName, description: fields.description || skill.description, requirements: fields.requirements || [], showcase: preparingFrom?.metadata.showcase || [] };
            // The selected publication target owns the cloud ID; never reuse a
            // legacy metadata ID as an implicit update destination.
            delete metadata.skillId;
            replace(await preparePublication(localSkillId, metadata, { publicationTarget, marketSkillId: publicationTarget === "existing" ? marketSkillId : undefined }, preparingFrom?.planId));
            setPreparingFrom(null);
            setCreating(false); message.success("已准备本机草稿，请检查文件后确认上传");
        });
    };
    const selectSkill = (id: string) => {
        const skill = skills.find(item => item.skillId === id);
        if (skill) form.setFieldsValue({ name: skill.skillName, description: skill.description, versionLabel: skill.version || "1.0.0", publicationTarget: skill.marketRelease || skill.originalSkillId ? undefined : "new", marketSkillId: undefined });
    };
    const reprepare = (plan: PublishPlan) => run(async () => {
        const { skill } = await getSkill(plan.skillId);
        if (skill.versionId !== plan.versionId) throw new Error("本机技能已更新，原稿仍保留。请从“我的技能”检查当前文件后重新准备投稿。");
        setSkills(items => [skill, ...items.filter(item => item.skillId !== skill.skillId)]);
        form.resetFields();
        form.setFieldsValue({ ...plan.metadata, requirements: [...plan.metadata.requirements], localSkillId: plan.skillId, publicationTarget: undefined, marketSkillId: plan.marketSkillId || plan.metadata.skillId });
        setPreparingFrom(plan); setConfirmed(false); setCreating(true);
    });
    return <section aria-label="技能投稿">
        <div className="skill-publish-status">
            <p>投稿分两步：先将选定文件上传为私有草稿，再检查公开预览并确认送审。只有审核通过后，其他人才能下载。</p>
            <div className="skill-market-actions">
                <span>{auth.connected ? "投稿账号已连接" : "投稿前需要在官网授权"}</span>
                {auth.connected ? <Button disabled={busy} onClick={() => void run(async () => { await disconnectMarketAuthorization(); setAuth({ connected: false }); })}>断开投稿账号</Button> : <Button loading={busy} onClick={() => void run(async () => { const value = await startMarketAuthorization(); setAuth(value); if (value.verificationUrl) await openSkillWebsite(value.verificationUrl); })}>连接投稿账号</Button>}
                <Button disabled={busy} onClick={() => void run(async () => { const value = await getMarketAuthorization(); setAuth(value); if (!value.connected) message.info("授权尚未完成，请在官网确认后重试"); })}>检查授权状态</Button>
                <Button onClick={() => void run(() => openSkillWebsite(`${website}/mine`))}>官网投稿与审核结果</Button>
            </div>
            {auth.userCode && !auth.connected ? <p>确认码：<strong>{auth.userCode}</strong>。请在打开的官网核对，完成后返回检查授权状态。</p> : null}
        </div>
        {error ? <Alert type="error" showIcon title={error} className="mb-4" /> : null}
        <div className="skill-market-actions mb-4"><Button type="primary" onClick={() => { setPreparingFrom(null); setCreating(true); form.resetFields(); }}>准备新投稿</Button><Button onClick={() => void reload()} loading={loading}>刷新本机草稿</Button></div>
        {loading ? <Skeleton active /> : creating ? <Form form={form} layout="vertical" className="max-w-3xl" initialValues={{ versionLabel: "1.0.0", requirements: [], sourceUrl: "", publicationTarget: "new" }}>
            {preparingFrom ? <Alert type="info" title="沿用原稿的文件与版本。修改后生成新的本机草稿，原稿继续保留；请重新检查并确认上传。" className="mb-4" /> : null}
            <Form.Item name="localSkillId" label="选择本机技能" rules={[{ required: true, message: "请选择一个技能" }]}><Select disabled={Boolean(preparingFrom)} onChange={selectSkill} options={skills.filter(skill => skill.sourceType !== "market").map(skill => ({ value: skill.skillId, label: skill.skillName }))} /></Form.Item>
            <Form.Item name="publicationTarget" label="投稿目标" rules={[{ required: true, message: "请明确选择这次投稿的目标" }]} extra="改写他人的技能请选择新技能，并填写来源链接。"><Select options={[{ value: "new", label: "发布新技能" }, { value: "existing", label: "为我的市场技能发布新版本" }]} /></Form.Item>
            {publicationTarget === "existing" ? <Form.Item name="marketSkillId" label="已有市场技能编号" extra="在官网打开自己已发布的技能，从页面链接中复制技能编号。请勿填写本机技能编号。" rules={[{ required: true, message: "请填写你已发布的市场技能编号" }, { validator: (_, value) => value === form.getFieldValue("localSkillId") ? Promise.reject(new Error("这是本机技能编号；首次投稿请选择发布新技能。")) : Promise.resolve() }]}><Input /></Form.Item> : null}
            <Form.Item name="name" label="公开名称" rules={[{ required: true, message: "请填写公开名称" }]}><Input maxLength={80} /></Form.Item>
            <Form.Item name="description" label="用途和输入输出" rules={[{ required: true, message: "请说明输入、输出和使用场景" }]}><Input.TextArea rows={4} maxLength={500} /></Form.Item>
            <div className="grid gap-4 sm:grid-cols-2"><Form.Item name="versionLabel" label="版本" rules={[{ required: true, message: "请填写版本" }]}><Input maxLength={64} /></Form.Item><Form.Item name="license" label="许可证" rules={[{ required: true, message: "请选择你有权采用的许可证" }]}><Select options={["MIT", "Apache-2.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0"].map(value => ({ value, label: value }))} /></Form.Item></div>
            <Form.Item name="sourceUrl" label="来源链接（改写他人内容时请填写）" rules={[{ type: "url", message: "请填写完整链接" }]}><Input /></Form.Item>
            <Form.Item name="requirements" label="必需工具与理解能力" extra="纯文字技能留空。请移除任何未确认的选项；具体使用条件写在下方。" rules={[{ validator: (_, value: string[] = []) => unsupportedRequirements(value).length ? Promise.reject(new Error("请移除未确认的能力；纯文字技能留空即可。")) : Promise.resolve() }]}><Select mode="multiple" allowClear options={[...capabilityOptions, ...unsupportedRequirements(formRequirements).map(value => ({ value, label: requirementLabel(value) }))]} /></Form.Item>
            <Form.Item name="requirementNotes" label="模型、素材和费用说明"><Input.TextArea rows={3} maxLength={1000} placeholder="例如：使用图片理解模型核对参考图，生成视频时按所选模型计费。" /></Form.Item>
            <p className="skill-market-help">请先在助手中试用。不要上传密钥、私人素材或没有分享许可的内容。</p><div className="skill-market-actions"><Button type="primary" loading={busy} onClick={() => void makePlan()}>准备文件预览</Button><Button onClick={() => setCreating(false)}>返回稿件</Button></div>
        </Form> : <div className="skill-publish-layout">
            <nav className="skill-publish-list" aria-label="本机投稿草稿">{plans.map(plan => <Button key={plan.planId} aria-pressed={selected === plan.planId} onClick={() => setSelected(plan.planId)}><span>{plan.metadata.name}<br /><small>{publicationStatus(plan.status)}</small></span></Button>)}</nav>
            {current ? <article className="skill-market-preview" key={current.planId}><h2>{current.metadata.name} · {current.metadata.versionLabel}</h2><p>{publicationStatus(current.status)}</p><p>{current.metadata.description}</p><p>许可：{current.metadata.license}</p><p>使用条件：{current.metadata.requirements.map(requirementLabel).join("、") || "没有额外工具要求"}</p>{current.metadata.requirementNotes ? <p>{current.metadata.requirementNotes}</p> : null}
                <p>投稿目标：{current.publicationTarget === "existing" ? `已有市场技能的新版本 · ${current.marketSkillId}` : needsPublicationTargetCorrection(current) ? "需要确认" : "发布新技能"}</p>
                {needsPublicationTargetCorrection(current) ? <Alert type="warning" title="请修改信息并明确选择投稿目标，再重新准备。原稿和文件会继续保留。" /> : null}
                {unsupportedRequirements(current.metadata.requirements).length ? <Alert type="warning" title="这份草稿包含未确认的使用条件，请修改信息后重新准备。纯文字技能无需额外理解能力。" /> : null}
                {!current.submissionId && current.status === "awaiting_upload_confirmation" ? <Button disabled={busy} onClick={() => void reprepare(current)}>修改信息并重新准备</Button> : null}
                <h3>文件清单</h3><ul>{current.files.map(file => <li key={file.path}>{file.path} · {file.size} 字节</li>)}</ul>
                {current.instruction ? <><h3>SKILL.md 正文</h3><pre>{current.instruction}</pre></> : null}
                {current.preview?.warnings?.map(value => <Alert key={value} type="warning" title={value} />)}
                {current.reviewReason ? <Alert type="info" title="审核意见" description={current.reviewReason} /> : null}
                {current.status === "awaiting_upload_confirmation" || current.status === "uploading" ? <><Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>我已核对文件和分享权限，确认上传为私有草稿。</Checkbox><div className="skill-market-actions"><Button type="primary" disabled={!confirmed || !auth.connected || needsPublicationTargetCorrection(current) || unsupportedRequirements(current.metadata.requirements).length > 0} loading={busy} onClick={() => void run(async () => { replace(await uploadPublication(current)); message.success("已读取公开预览，请再次核对后送审"); })}>确认上传私有草稿</Button></div></> : null}
                {current.status === "awaiting_submit_confirmation" ? <><p>通过审核后，以上内容和文件将公开。此预览对应作者：{current.preview?.author}。</p><Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>我已检查这份公开预览，确认提交审核。</Checkbox><div className="skill-market-actions"><Button type="primary" disabled={!auth.connected || !canSubmitPublication(current, confirmed)} loading={busy} onClick={() => void run(async () => { replace(await submitPublication(current)); message.success("已送审，可在官网查看结果和修改意见"); })}>确认送审</Button></div></> : null}
                {current.submissionId ? <div className="skill-market-actions"><Button loading={busy} onClick={() => void run(async () => replace(await refreshPublication(current.planId)))}>刷新预览与审核状态</Button><Button onClick={() => void run(() => openSkillWebsite(`${website}/submissions/${encodeURIComponent(current.submissionId!)}`))}>在官网修改稿件</Button></div> : null}
                {current.status === "rejected" ? <p>请在官网按审核意见修改，保存后回到这里刷新预览，再次确认送审。</p> : null}
            </article> : <p className="skill-market-empty">还没有投稿草稿。可以选择自己的技能准备投稿，也可以让画布助手先整理草稿。</p>}
        </div>}
    </section>;
}
