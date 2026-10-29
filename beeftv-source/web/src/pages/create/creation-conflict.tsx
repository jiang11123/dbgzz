import { AppModal } from "@/components/ui/product/app-modal";
import type { CreationConversation } from "./creation-types";

export type CreationConflictPreview = {
    title: string;
    messageCount: number;
    excerpt: string;
};

export function creationConflictPreview(conversation: { title?: string; messages?: Array<{ role?: string; content?: string }> } | undefined): CreationConflictPreview {
    const messages = conversation?.messages || [];
    const lastUser = [...messages].reverse().find((item) => item.role === "user" && String(item.content || "").trim());
    const excerpt = String(lastUser?.content || "").trim().replace(/\s+/g, " ");
    return {
        title: String(conversation?.title || "").trim() || "未命名对话",
        messageCount: messages.length,
        excerpt: excerpt ? (excerpt.length > 42 ? `${excerpt.slice(0, 41)}…` : excerpt) : "还没有文字",
    };
}

export function CreationConflictBanner({
    parked,
    onReview,
    onUseSaved,
    onRestoreParked,
}: {
    parked?: boolean;
    onReview: () => void;
    onUseSaved: () => void;
    onRestoreParked?: () => void;
}) {
    if (parked) {
        return (
            <div className="creation-conflict-banner" role="status">
                <p>已改为已保存的版本。刚才的草稿还在，可以再换回来。</p>
                <div className="creation-conflict-banner-actions">
                    <button type="button" onClick={onRestoreParked}>恢复刚才的草稿</button>
                </div>
            </div>
        );
    }
    return (
        <div className="creation-conflict-banner" role="status">
            <p>这份对话和已保存的版本不一样。先看两边，再决定用哪一份。</p>
            <div className="creation-conflict-banner-actions">
                <button type="button" onClick={onReview}>查看两边</button>
                <button type="button" onClick={onUseSaved}>用已保存的版本</button>
            </div>
        </div>
    );
}

export function CreationConflictDialog({
    open,
    local,
    remote,
    onClose,
    onUseSaved,
    onUseLocal,
}: {
    open: boolean;
    local?: CreationConversation;
    remote?: CreationConversation;
    onClose: () => void;
    onUseSaved: () => void;
    onUseLocal: () => void;
}) {
    const localPreview = creationConflictPreview(local);
    const remotePreview = creationConflictPreview(remote);
    return (
        <AppModal
            open={open}
            title="有两个版本"
            onCancel={onClose}
            footer={null}
            centered
            width="min(560px, calc(100vw - 32px))"
            className="creation-conflict-modal"
        >
            <div className="creation-conflict-dialog">
                <p className="creation-conflict-lead">先看两边的标题和最近一句。用已保存的版本时，这份草稿会留下来，之后还能换回来。</p>
                <div className="creation-conflict-cards">
                    <section className="creation-conflict-card">
                        <h3>这份草稿</h3>
                        <p className="creation-conflict-title">{localPreview.title}</p>
                        <p>{localPreview.messageCount} 条消息</p>
                        <p className="creation-conflict-excerpt">{localPreview.excerpt}</p>
                    </section>
                    <section className="creation-conflict-card">
                        <h3>已保存的版本</h3>
                        <p className="creation-conflict-title">{remotePreview.title}</p>
                        <p>{remotePreview.messageCount} 条消息</p>
                        <p className="creation-conflict-excerpt">{remotePreview.excerpt}</p>
                    </section>
                </div>
                <div className="creation-conflict-dialog-actions">
                    <button type="button" onClick={onUseLocal}>用这份草稿替换已保存的版本</button>
                    <button type="button" className="is-primary" onClick={onUseSaved}>用已保存的版本</button>
                    <button type="button" className="is-quiet" onClick={onClose}>先不处理</button>
                </div>
            </div>
        </AppModal>
    );
}
