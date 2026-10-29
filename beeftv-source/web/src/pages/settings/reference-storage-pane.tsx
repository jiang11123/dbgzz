import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Switch } from "antd";
import { getDesktopAppBinding, type ReferenceStorageConfig } from "@/services/desktop-runtime";

const fields = [
    ["endpoint", "S3 端点", "https://…"],
    ["bucket", "存储桶名称", "例如 beeftv-media"],
    ["region", "区域", "R2 使用 auto；S3 使用存储桶所在区域"],
    ["accessKeyId", "Access Key ID", ""],
    ["publicBaseURL", "存储桶公网地址", "https://media.example.com"],
] as const;

export function ReferenceStoragePane() {
    const binding = getDesktopAppBinding();
    const { message } = App.useApp();
    const [config, setConfig] = useState<ReferenceStorageConfig>({ enabled: false, endpoint: "", bucket: "", region: "auto", accessKeyId: "", publicBaseURL: "", hasSecret: false });
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; detail: string } | null>(null);
    useEffect(() => {
        let active = true;
        void binding
            ?.ReferenceStorageSettings?.()
            .then((value) => {
                if (active) setConfig(value);
            })
            .catch(() => {
                if (active) setLoadError(true);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [binding]);
    if (!binding?.SaveReferenceStorage) return null;
    const save = async (test = false) => {
        setBusy(true);
        setTestResult(null);
        try {
            const value = await binding.SaveReferenceStorage!({ ...config, secretAccessKey: secret });
            setConfig(value);
            setSecret("");
            if (test) {
                await binding.TestReferenceStorage!();
                setTestResult({ success: true, detail: "上传、公开读取和测试文件清理均已通过" });
            } else message.success("对象存储配置已保存");
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (test) setTestResult({ success: false, detail });
            else message.error(detail);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="settings-section storage-settings-block space-y-4" aria-label="参考素材对象存储">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>参考素材对象存储</h2>
                </div>
            </div>
            <label className="flex items-center justify-between gap-4 text-sm">
                <span>生成时上传需要公网地址的参考素材</span>
                <Switch checked={config.enabled} disabled={loadError || busy || loading} onChange={(enabled) => { setTestResult(null); setConfig((value) => ({ ...value, enabled })); }} />
            </label>
            <p className="text-sm leading-6 text-foreground/60">启用后，需要在线素材的渠道会使用上传后的链接。原始素材仍保存在本机；存储及流量由你的存储服务计费。</p>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
                {fields.map(([key, label, placeholder]) => (
                    <label key={key} className="block min-w-0 space-y-2 text-sm">
                        <span>{label}</span>
                        <Input aria-label={label} value={config[key]} placeholder={placeholder} disabled={busy || loadError || loading} autoComplete="off" onChange={(event) => { setTestResult(null); setConfig((value) => ({ ...value, [key]: event.target.value })); }} />
                    </label>
                ))}
                <label className="block min-w-0 space-y-2 text-sm">
                    <span>Secret Access Key</span>
                    <Input.Password
                        aria-label="Secret Access Key"
                        value={secret}
                        autoComplete="new-password"
                        placeholder={config.hasSecret ? "已保存，留空保持" : "请输入访问密钥"}
                        disabled={busy || loadError || loading}
                        onChange={(event) => { setTestResult(null); setSecret(event.target.value); }}
                    />
                </label>
            </div>
            {loadError ? (
                <p role="alert" className="text-sm text-destructive">
                    已有配置暂时无法读取，请先导出问题记录，避免覆盖。
                </p>
            ) : null}
            {testResult && <Alert showIcon type={testResult.success ? "success" : "error"} title={testResult.success ? "存储测试通过" : "存储测试未通过"} description={testResult.detail} />}
            <div className="flex flex-wrap gap-3">
                <Button onClick={() => void save()} loading={busy} disabled={loading || loadError}>保存对象存储配置</Button>
                {binding.TestReferenceStorage && <Button onClick={() => void save(true)} loading={busy} disabled={loading || loadError || !config.enabled}>保存并测试上传</Button>}
            </div>
            <p className="text-sm leading-6 text-foreground/60">支持 S3 兼容存储。测试会上传一张小图片，检查公开读取后删除；存储服务可能收取少量请求费用。</p>
        </section>
    );
}
