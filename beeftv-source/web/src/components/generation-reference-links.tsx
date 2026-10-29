import { useState } from "react";
import { Alert, Button, Input, type App } from "antd";
import { navigateToSettings } from "@/lib/settings-navigation";
import { isUserScopeAbandonedError } from "@/lib/user-scope-guard";
import { startOperation } from "@/stores/use-operation-progress";
import { isReferenceHTTPSLink, uploadReferenceLinks, type ReferenceLinkRequest, type ResolveReferenceLinks } from "@/services/api/reference-link-replacement";

type ModalAPI = ReturnType<typeof App.useApp>["modal"];

export function ReferenceLinkFields({ references, onChange }: { references: ReferenceLinkRequest[]; onChange: (links: Record<string, string>) => void }) {
    const [links, setLinks] = useState<Record<string, string>>({});
    return (
        <div data-canvas-no-zoom data-canvas-wheel-scroll>
            <p>当前渠道只能读取在线素材。请填写对应素材的 HTTPS 链接，用于本次生成。</p>
            <div style={{ maxHeight: "45vh", overflowY: "auto", display: "grid", gap: 12 }}>
                {references.map((reference) => (
                    <label key={reference.key} style={{ display: "grid", gap: 4 }}>
                        <span style={{ overflowWrap: "anywhere" }}>
                            {reference.label}
                            {reference.name ? ` · ${reference.name}` : ""}
                        </span>
                        <Input
                            aria-label={reference.label}
                            value={links[reference.key] || ""}
                            placeholder="https://…"
                            autoComplete="off"
                            status={links[reference.key] && !isReferenceHTTPSLink(links[reference.key]) ? "error" : undefined}
                            onChange={(event) => {
                                const next = { ...links, [reference.key]: event.target.value };
                                setLinks(next);
                                onChange(next);
                            }}
                        />
                    </label>
                ))}
            </div>
            <p>链接需允许服务商直接读取。原素材会保留。</p>
        </div>
    );
}

// One generation may submit several images concurrently; share one decision for identical inputs.
export function createReferenceLinkResolver(modal: ModalAPI): ResolveReferenceLinks {
    const requests = new Map<string, Promise<Record<string, string> | null>>();
    return (references, signal, target) => {
        if (signal?.aborted) return Promise.resolve(null);
        const key = JSON.stringify(references);
        const existing = requests.get(key);
        if (existing) {
            if (!target) return existing;
            const waiting = startOperation("准备参考素材", { target, detail: "正在等待参考素材确认" });
            return existing.finally(() => waiting.dismiss());
        }
        const pending = (async () => {
            let uploaded: Record<string, string> = {};
            let uploadError = "";
            try {
                uploaded = await uploadReferenceLinks(references, signal, target);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                if (signal?.aborted) return null;
                uploadError = error instanceof Error ? error.message : String(error);
            }
            const missing = references.filter((item) => !uploaded[item.key]);
            if (!missing.length) return uploaded;
            return new Promise<Record<string, string> | null>((resolve) => {
                let links: Record<string, string> = {};
                const finish = (result: Record<string, string> | null) => {
                    signal?.removeEventListener("abort", cancel);
                    resolve(result);
                };
                const dialog = modal.confirm({
                    title: "填写参考素材链接",
                    centered: true,
                    closable: true,
                    width: 520,
                    okText: "使用链接并生成",
                    cancelText: "取消",
                    okButtonProps: { disabled: true },
                    content: (
                        <>
                            {uploadError && <Alert type="warning" showIcon title="对象存储上传未完成" description={`${uploadError}。可检查存储设置，或填写可公开读取的 HTTPS 链接继续。`} style={{ marginBottom: 16 }} />}
                            <ReferenceLinkFields
                                references={missing}
                                onChange={(value) => {
                                    links = value;
                                    dialog.update({ okButtonProps: { disabled: !missing.every((item) => isReferenceHTTPSLink(value[item.key] || "")) } });
                                }}
                            />
                            <Button
                                onClick={() => {
                                    finish(null);
                                    dialog.destroy();
                                    navigateToSettings({ section: "channels", continueCreation: true });
                                }}
                            >
                                切换渠道
                            </Button>
                            <Button onClick={() => { finish(null); dialog.destroy(); navigateToSettings({ section: "storage", continueCreation: true }); }}>
                                配置对象存储
                            </Button>
                        </>
                    ),
                    onOk: () => finish({ ...uploaded, ...links }),
                    onCancel: () => finish(null),
                });
                const cancel = () => {
                    finish(null);
                    dialog.destroy();
                };
                signal?.addEventListener("abort", cancel, { once: true });
                if (signal?.aborted) cancel();
            });
        })();
        requests.set(key, pending);
        void pending.then(() => requests.delete(key), () => requests.delete(key));
        return pending;
    };
}
