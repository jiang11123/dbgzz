import { useEffect, useState } from "react";
import { App, Button, Input, Upload, type UploadFile } from "antd";
import { Select } from "@/components/ui/base/select";
import { isReferenceHTTPSLink } from "@/services/api/reference-link-replacement";
import { AppModal } from "@/components/ui/product/app-modal";
import { FileImage, FileText, Film, Music2, UploadCloud, X } from "lucide-react";

import { isAudioFile } from "@/lib/canvas/canvas-project-generation";

import { CANVAS_UPLOAD_ACCEPT, isTextUploadFile, uploadNodeType } from "@/lib/canvas/canvas-file-upload";

type CanvasUploadModalProps = {
    open: boolean;
    onClose: () => void;
    onUpload: (files: File[]) => Promise<boolean>;
    onImportUrl: (url: string,kind: "image" | "video" | "audio") => Promise<boolean>;
};

export function CanvasUploadModal({ open, onClose, onUpload, onImportUrl }: CanvasUploadModalProps) {
    const { message } = App.useApp();
    const [fileList, setFileList] = useState<UploadFile[]>([]);
    const [uploading, setUploading] = useState(false);
    const [url,setUrl] = useState("");
    const [kind,setKind] = useState<"image" | "video" | "audio">("image");
    const submitUrl = async () => {
        if(!isReferenceHTTPSLink(url)) return;
        setUploading(true);
        try { if(await onImportUrl(url.trim(),kind)) { setUrl(""); onClose(); } }
        catch(error) { message.error(error instanceof Error ? error.message : "链接添加失败"); }
        finally { setUploading(false); }
    };

    useEffect(() => {
        if (!open) {
            setFileList([]);
            setUploading(false);
            setUrl("");
            setKind("image");
        }
    }, [open]);

    const submit = async () => {
        const files = fileList.flatMap((item) => item.originFileObj ? [item.originFileObj] : []);
        if (!files.length) return;
        setUploading(true);
        try {
            const pendingUpload = onUpload(files);
            onClose();
            await pendingUpload;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "文件上传失败，请稍后重试");
        } finally {
            setUploading(false);
        }
    };

    return (
        <AppModal
            open={open}
            title={null}
            footer={null}
            width="min(720px, calc(100vw - 24px))"
            destroyOnHidden
            closable={!uploading}
            keyboard={!uploading}
            mask={{ closable: !uploading }}
            onCancel={onClose}
            flush
        >
            <div className="flex min-h-96 flex-col overflow-hidden">
                <header className="flex h-14 shrink-0 items-center justify-between border-b border-border py-0 pl-5 pr-12">
                    <div className="min-w-0">
                        <div role="heading" aria-level={2} className="text-sm font-semibold leading-5">添加素材</div>
                        <div className="mt-0.5 text-[var(--fs-label)] leading-4 text-foreground/60">导入本地文件或在线素材</div>
                    </div>
                    <span className="shrink-0 text-[var(--fs-label)] text-foreground/45">已选 {fileList.length} 项</span>
                </header>

                <section className="min-h-0 flex-1 overflow-y-auto p-4">
                    <Upload.Dragger
                        accept={CANVAS_UPLOAD_ACCEPT}
                        multiple
                        disabled={uploading}
                        fileList={fileList}
                        beforeUpload={(file) => {
                            if (isCanvasUploadFile(file)) return false;
                            message.warning(`“${file.name}”不是支持的图片、视频、音频或 TXT / Markdown 文件`);
                            return Upload.LIST_IGNORE;
                        }}
                        onChange={({ fileList: nextFileList }) => setFileList(nextFileList)}
                        showUploadList={false}
                        styles={{
                            root: { display: "block", width: "100%" },
                            trigger: { borderColor: "var(--border)", borderRadius: "var(--r-lg)", background: "var(--workspace-surface)" },
                        }}
                    >
                        <div className="flex min-h-48 flex-col items-center justify-center px-6 py-8 text-center">
                            <span className="grid size-12 place-items-center rounded-lg bg-foreground/[.06] text-foreground/70">
                                <UploadCloud className="size-6" aria-hidden="true" />
                            </span>
                            <p className="mt-4 text-sm font-medium">拖动文件到这里，或点击选择</p>
                            <p className="mt-1 text-xs text-foreground/45">支持同时选择多个文件</p>
                            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-[var(--fs-label)] text-foreground/45" aria-label="支持的文件类型">
                                <span className="inline-flex items-center gap-1"><FileImage className="size-3.5" aria-hidden="true" />图片</span>
                                <span className="inline-flex items-center gap-1"><Film className="size-3.5" aria-hidden="true" />视频</span>
                                <span className="inline-flex items-center gap-1"><Music2 className="size-3.5" aria-hidden="true" />音频</span>
                                <span className="inline-flex items-center gap-1"><FileText className="size-3.5" aria-hidden="true" />TXT / Markdown</span>
                            </div>
                        </div>
                    </Upload.Dragger>

                    {fileList.length ? (
                        <div className="thin-scrollbar mt-3 flex max-h-52 flex-wrap gap-3 overflow-y-auto" aria-label="已选文件">
                            {fileList.map((file) => (
                                <article key={file.uid} className="group w-24 min-w-0 overflow-hidden rounded-lg bg-muted">
                                    <div className="relative aspect-square overflow-hidden bg-muted">
                                        <CanvasUploadFilePreview file={file} />
                                        <button
                                            type="button"
                                            title={`移除 ${file.name}`}
                                            aria-label={`移除 ${file.name}`}
                                            disabled={uploading}
                                            className="absolute right-1 top-1 grid size-6 place-items-center rounded-md bg-black/60 text-white transition-opacity hover:bg-black/75 disabled:cursor-not-allowed disabled:opacity-50"
                                            onClick={() => setFileList((current) => current.filter((item) => item.uid !== file.uid))}
                                        >
                                            <X className="size-3.5" aria-hidden="true" />
                                        </button>
                                    </div>
                                    <div className="truncate px-2 py-1.5 text-[var(--fs-micro)] text-foreground/70" title={file.name}>{file.name}</div>
                                </article>
                            ))}
                        </div>
                    ) : null}
                </section>

                <section className="space-y-3 border-t border-border p-4" data-canvas-no-zoom>
                    <label className="block text-sm" htmlFor="canvas-media-url">在线素材地址</label>
                    <div className="flex min-w-0 flex-wrap gap-2">
                        <Select ariaLabel="素材类型" value={kind} options={[{value:"image",label:"图片"},{value:"video",label:"视频"},{value:"audio",label:"音频"}]} onChange={value=>setKind(value === "video" ? "video" : value === "audio" ? "audio" : "image")} />
                        <Input id="canvas-media-url" className="min-w-0 flex-1" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://…" disabled={uploading} autoComplete="off"/>
                        <Button onClick={()=>void submitUrl()} disabled={!isReferenceHTTPSLink(url)} loading={uploading}>添加链接</Button>
                    </div>
                    <p className="text-xs leading-5 text-foreground/60">保留原始网址用于生成，请使用服务商可直接读取的 HTTPS 素材链接。</p>
                </section>
                <footer className="flex h-14 shrink-0 items-center justify-between border-t border-border px-4">
                    <span className="hidden text-[var(--fs-label)] text-foreground/45 sm:inline">文件将在确认后按顺序添加到画布</span>
                    <div className="ml-auto flex gap-2">
                        <Button disabled={uploading} onClick={onClose}>取消</Button>
                        <Button type="primary" icon={<UploadCloud className="size-4" />} disabled={!fileList.length} loading={uploading} onClick={() => void submit()}>
                            添加到画布{fileList.length ? `（${fileList.length}）` : ""}
                        </Button>
                    </div>
                </footer>
            </div>
        </AppModal>
    );
}

function CanvasUploadFilePreview({ file }: { file: UploadFile }) {
    const source = file.originFileObj;
    const [previewUrl, setPreviewUrl] = useState("");

    useEffect(() => {
        if (!source || (!source.type.startsWith("image/") && !source.type.startsWith("video/"))) return;
        const objectUrl = URL.createObjectURL(source);
        setPreviewUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [source]);

    if (source?.type.startsWith("image/") && previewUrl) {
        return <img src={previewUrl} alt={`预览：${file.name}`} className="size-full object-cover" />;
    }
    if (source?.type.startsWith("video/") && previewUrl) {
        return <video src={previewUrl} aria-label={`预览：${file.name}`} muted playsInline preload="metadata" className="size-full object-cover" />;
    }
    return (
        <div className="grid size-full place-items-center text-foreground/45">
            {source && isTextUploadFile(source) ? <FileText className="size-7" aria-hidden="true" /> : source && (source.type.startsWith("audio/") || isAudioFile(source)) ? <Music2 className="size-7" aria-hidden="true" /> : <FileImage className="size-7" aria-hidden="true" />}
        </div>
    );
}

function isCanvasUploadFile(file: File) {
    return Boolean(uploadNodeType(file));
}
