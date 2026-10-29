import type { AiConfig } from "@/stores/use-config-store";
import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { Switch } from "@/components/ui/base/switch";

type Key = "size" | "transparentBackground" | "seedreamMode" | "seedreamMaxImages" | "seedreamOutputFormat" | "seedreamOptimize" | "seedreamWatermark";

export function SeedreamSettings({ config, family, profile, onChange, theme }: { config: AiConfig; family: string; profile: ImageCapabilityConfig; onChange: (key: Key, value: string) => void; theme: CanvasTheme }) {
    const modern = family === "pro" || family === "flash";
    const layers = config.seedreamMode === "layers";
    const style = { background: theme.canvas.background, color: theme.node.text, borderColor: theme.node.stroke };
    return <div className="space-y-3">
        {modern ? <label className="flex items-center justify-between gap-3 text-xs"><span>图层拆分</span><Switch size="sm" checked={layers} onChange={(checked) => { onChange("seedreamMode", checked ? "layers" : "image"); if (checked) onChange("transparentBackground", "false"); if (!checked && config.size === "auto") onChange("size", "2K"); }} /></label> : null}
        {layers ? <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>连接一张图片，拆出底图与透明图层。可在提示词中指定要分离的元素。</p> : <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>支持文字生成、参考图编辑和多图融合。局部编辑可上传标注图，或在提示词中指定位置。</p>}
        <label className="block space-y-1.5 text-xs"><span>分辨率</span><select aria-label="Seedream 分辨率" className="h-8 w-full rounded-lg border px-2" style={style} value={profile.size.values.includes(config.size) || config.size === "auto" ? config.size : "custom"} onChange={(event) => onChange("size", event.target.value === "custom" ? "2048x2048" : event.target.value)}>
            {profile.size.values.map((value) => <option key={value} value={value}>{value}</option>)}
            {layers ? <option value="auto">跟随原图</option> : <option value="custom">自定义宽高</option>}
        </select></label>
        {!layers && !profile.size.values.includes(config.size) ? <label className="block space-y-1.5 text-xs"><span>宽 × 高（像素）</span><input aria-label="Seedream 自定义宽高" className="h-8 w-full rounded-lg border px-2" style={style} value={config.size} onChange={(event) => onChange("size", event.target.value)} placeholder="2048x2048" /></label> : null}
        {!modern ? <label className="block space-y-1.5 text-xs"><span>关联组图上限</span><input aria-label="关联组图上限" type="number" min={1} max={15} className="h-8 w-full rounded-lg border px-2" style={style} value={config.seedreamMaxImages || "1"} onChange={(event) => onChange("seedreamMaxImages", event.target.value)} /><span className="block leading-relaxed" style={{ color: theme.node.muted }}>同一次生成中的关联图片，按实际出图收费；参考图与输出图合计最多 15 张。</span></label> : null}
        {profile.outputFormat.supported ? <label className="block space-y-1.5 text-xs"><span>{layers ? "底图格式" : "图片格式"}</span><select aria-label="Seedream 图片格式" className="h-8 w-full rounded-lg border px-2" style={style} value={config.transparentBackground === "true" ? "png" : config.seedreamOutputFormat || "png"} onChange={(event) => onChange("seedreamOutputFormat", event.target.value)}><option value="png">PNG</option><option value="jpeg" disabled={config.transparentBackground === "true"}>JPEG</option></select></label> : null}
        <label className="block space-y-1.5 text-xs"><span>提示词优化</span><select aria-label="Seedream 提示词优化" className="h-8 w-full rounded-lg border px-2" style={style} value={config.seedreamOptimize || "standard"} onChange={(event) => onChange("seedreamOptimize", event.target.value)}><option value="standard">标准</option>{family === "pro" || family === "4.0" ? <option value="fast">快速</option> : null}</select></label>
        <label className="flex items-center justify-between gap-3 text-xs"><span>AI 水印</span><Switch size="sm" checked={config.seedreamWatermark === "true"} onChange={(checked) => onChange("seedreamWatermark", checked ? "true" : "false")} /></label>
    </div>;
}
