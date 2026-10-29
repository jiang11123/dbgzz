import { Select } from "antd";
import type { ReferenceMediaTransport } from "@/stores/use-config-store";

export function ReferenceMediaTransportFields({ value, onChange }: { value?: ReferenceMediaTransport; onChange: (value: ReferenceMediaTransport) => void }) {
    return <section className="space-y-3">
        <div className="text-xs font-medium">参考素材传输</div>
        <p className="text-xs leading-5 text-foreground/58">默认按请求协议处理。第三方接口要求不同，可分别调整图片、视频和音频的传输方式。</p>
        {(["image", "video", "audio"] as const).map((kind) => <label key={kind} className="flex min-w-0 flex-wrap items-center gap-3 text-xs">
            <span className="w-12 shrink-0">{{ image: "图片", video: "视频", audio: "音频" }[kind]}</span>
            <Select
                aria-label={`${{ image: "图片", video: "视频", audio: "音频" }[kind]}传输方式`}
                className="min-w-0 flex-1"
                value={value?.[kind] || "auto"}
                options={[{ value: "auto", label: "自动，按协议处理" }, { value: "inline", label: "直接传素材" }, { value: "url", label: "上传到我的对象存储" }, { value: "link", label: "手动填写 HTTPS 链接" }]}
                onChange={(transport) => onChange({ ...value, [kind]: transport })}
            />
        </label>)}
        <p className="text-xs leading-5 text-foreground/58">直接传素材使用当前协议的文件或 Base64 格式，需服务商支持。需要链接时，自动使用已启用的对象存储；未配置时可手动填写。</p>
    </section>;
}
