import { Button } from "antd";
import { useRef, useState } from "react";
import { AppModal } from "@/components/ui/product/app-modal";
import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";

// Capture scope at the entry point, before a lazy dialog can finish loading.
export function CanvasDeleteConfirmation({ title, description, scope, onConfirm, onCancel }: {
    title: string;
    description: string;
    scope: CapturedUserScope;
    onConfirm: (assertCurrent: () => void) => Promise<void>;
    onCancel: () => void;
}) {
    const busy = useRef(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");
    const confirm = async () => {
        if (busy.current) return;
        busy.current = true;
        setDeleting(true);
        setError("");
        try {
            const assertCurrent = () => assertUserScope(scope);
            assertCurrent();
            await onConfirm(assertCurrent);
            assertCurrent();
            onCancel();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "删除失败，请稍后重试");
        } finally {
            busy.current = false;
            setDeleting(false);
        }
    };
    return <AppModal open centered title={title} closable={!deleting} keyboard={!deleting} maskClosable={!deleting}
        onCancel={() => { if (!busy.current) onCancel(); }}
        footer={<><Button disabled={deleting} onClick={onCancel}>取消</Button><Button danger type="primary" loading={deleting} onClick={() => void confirm()}>删除</Button></>}>
        <p className="text-sm text-foreground/60">{description}</p>
        {error ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
    </AppModal>;
}
