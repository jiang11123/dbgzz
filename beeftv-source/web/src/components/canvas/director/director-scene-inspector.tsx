import { InputNumber, Slider } from "antd";
import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/base/switch";
import { directorGroundSettings } from "@/lib/canvas/director/director-ground";
import { directorPanoramaSphere } from "@/lib/canvas/director/director-panorama-sphere";
import { directorStageTransform } from "@/lib/canvas/director/director-stage-transform";
import type { DirectorScene, DirectorVec3 } from "@/types/director";

type SceneEnvironmentPatch = Partial<Pick<DirectorScene, "background" | "environmentIntensity" | "gridVisible" | "gridSnap" | "panorama" | "panoramaRotation" | "panoramaRadius" | "ground" | "stageTransform" | "labelsVisible">>;

export function DirectorSceneInspector({ scene, onChange }: { scene: DirectorScene; onChange: (patch: SceneEnvironmentPatch) => void }) {
    const ground = directorGroundSettings(scene);
    const stage = directorStageTransform(scene);
    const sphere = directorPanoramaSphere(scene);
    const [skyHex, setSkyHex] = useState(() => scene.background.replace(/^#/, "").toUpperCase());
    useEffect(() => setSkyHex(scene.background.replace(/^#/, "").toUpperCase()), [scene.background]);
    const commitSkyHex = () => {
        if (!/^[0-9A-Fa-f]{6}$/.test(skyHex)) {
            setSkyHex(scene.background.replace(/^#/, "").toUpperCase());
            return;
        }
        const color = `#${skyHex.toUpperCase()}`;
        if (color.toLowerCase() !== scene.background.toLowerCase()) onChange({ background: color });
        setSkyHex(color.slice(1));
    };
    const updateGround = (patch: Partial<typeof ground>) => onChange({ ground: { ...ground, ...patch } });
    const updateAxis = (field: "position" | "rotation", axis: number, value: number) => {
        const next = [...stage[field]] as DirectorVec3;
        next[axis] = value;
        onChange({ stageTransform: { ...stage, [field]: next } });
    };
    return (
        <div className="text-sm">
            <h2 className="border-b px-4 py-4 text-base font-semibold" style={{ borderColor: "var(--border)" }}>3D场景</h2>
            <section className="space-y-3 border-b px-4 py-4" style={{ borderColor: "var(--border)" }} aria-label="场景变换">
                <div className="space-y-2">
                    <div className="text-[13px] opacity-50">场景缩放</div>
                    <div className="flex items-center gap-3">
                        <Slider ariaLabelForHandle="场景缩放" className="m-0 min-w-0 flex-1" min={0.1} max={10} step={0.1} value={stage.scale} onChangeComplete={(scale) => onChange({ stageTransform: { ...stage, scale } })} />
                        <InputNumber aria-label="场景缩放百分比" className="w-[72px] shrink-0" size="small" min={10} max={1000} step={10} suffix="%" value={Math.round(stage.scale * 100)} onChange={(percent) => { if (percent !== null) onChange({ stageTransform: { ...stage, scale: percent / 100 } }); }} />
                    </div>
                </div>
                {(["position", "rotation"] as const).map((field) => <div key={field} className="space-y-2">
                    <div className="text-[13px] opacity-50">场景{field === "position" ? "平移" : "旋转"}</div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis} className="flex min-w-0 items-center gap-1 rounded-lg px-2" style={{ background: "var(--director-dock-active-surface)" }}>
                            <span className="text-[11px] opacity-50">{axis}</span>
                            <InputNumber aria-label={`场景${field === "position" ? "平移" : "旋转"}${axis}`} className="min-w-0 flex-1" size="small" variant="borderless" controls={false} step={field === "position" ? 0.1 : 1} precision={field === "position" ? 1 : 0} value={stage[field][index]} onChange={(value) => { if (value !== null) updateAxis(field, index, value); }} />
                        </label>)}
                    </div>
                </div>)}
            </section>
            <section className="space-y-4 border-b px-4 py-4" style={{ borderColor: "var(--border)" }} aria-label="全景背景">
                <h3 className="font-semibold">全景背景</h3>
                <div className="space-y-2">
                    <span className="text-xs opacity-65">{scene.panorama ? "已连接全景图" : "尚未添加全景图"}</span>
                    {scene.panorama ? <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--border)" }}>
                        <span className="min-w-0 truncate">{scene.panorama.name || "全景图片"}</span>
                        <button type="button" aria-label="移除全景图" className="shrink-0 opacity-65 hover:opacity-100" onClick={() => onChange({ panorama: undefined })}>移除</button>
                    </div> : <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs opacity-55" style={{ borderColor: "var(--border)" }}>从左侧上传或选择图片</div>}
                </div>
                <div className="space-y-2">
                    <div className="text-xs opacity-65">天空颜色</div>
                    <div className="flex items-center gap-2">
                        <label className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-lg" style={{ background: scene.background }}>
                            <input type="color" aria-label="选择天空颜色" className="absolute inset-0 size-full cursor-pointer opacity-0" value={scene.background} onChange={(event) => onChange({ background: event.target.value })} />
                        </label>
                        <div className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-lg px-2 text-xs" style={{ background: "var(--director-dock-active-surface)" }}>
                            <span className="opacity-50">#</span>
                            <input type="text" aria-label="天空颜色色值" className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none" maxLength={6} spellCheck={false} value={skyHex} onChange={(event) => setSkyHex(event.target.value.toUpperCase())} onBlur={commitSkyHex} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setSkyHex(scene.background.replace(/^#/, "").toUpperCase()); event.currentTarget.blur(); } }} />
                        </div>
                    </div>
                </div>
            </section>
            <section className="space-y-4 border-b px-4 py-5" style={{ borderColor: "var(--border)" }} aria-label="全景球">
                <h3 className="font-semibold">全景球</h3>
                <div className="text-xs opacity-65">水平旋转</div>
                <div className="flex items-center gap-3">
                    <Slider aria-label="全景球水平旋转" className="m-0 min-w-0 flex-1" min={0} max={360} step={1} value={sphere.rotation} onChangeComplete={(panoramaRotation) => onChange({ panoramaRotation })} />
                    <InputNumber aria-label="全景球旋转角度" className="w-[72px] shrink-0" size="small" min={0} max={360} step={1} suffix="°" value={sphere.rotation} onChange={(panoramaRotation) => { if (panoramaRotation !== null) onChange({ panoramaRotation }); }} />
                </div>
                <div className="text-xs opacity-65">球形半径</div>
                <div className="flex items-center gap-3">
                    <Slider aria-label="全景球半径" className="m-0 min-w-0 flex-1" min={10} max={500} step={10} value={sphere.radius} onChangeComplete={(panoramaRadius) => onChange({ panoramaRadius })} />
                    <InputNumber aria-label="全景球半径数值" className="w-[72px] shrink-0" size="small" min={10} max={500} step={10} value={sphere.radius} onChange={(panoramaRadius) => { if (panoramaRadius !== null) onChange({ panoramaRadius }); }} />
                </div>
            </section>
            <div className="flex items-center justify-between gap-3 border-b px-4 py-4 text-xs" style={{ borderColor: "var(--border)" }}>
                <span>角色标签</span>
                <Switch size="sm" aria-label="角色标签" checked={scene.labelsVisible !== false} onChange={(labelsVisible) => onChange({ labelsVisible })} />
            </div>
            <div className="flex items-center justify-between gap-3 border-b px-4 py-4 text-xs" style={{ borderColor: "var(--border)" }}>
                <span>网格吸附</span>
                <Switch size="sm" aria-label="网格吸附" checked={scene.gridSnap === true} onChange={(gridSnap) => onChange({ gridSnap })} />
            </div>
            <div className="space-y-5 px-4 py-5">
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs"><span className="opacity-65">环境亮度</span><span>{Math.round(scene.environmentIntensity * 100)}%</span></div>
                    <Slider min={0} max={2} step={0.05} value={scene.environmentIntensity} onChangeComplete={(environmentIntensity) => onChange({ environmentIntensity })} />
                </div>
                <div className="flex items-center justify-between gap-3 text-xs">
                    <span>显示网格</span>
                    <Switch size="sm" aria-label="显示网格" checked={scene.gridVisible} onChange={(gridVisible) => onChange({ gridVisible })} />
                </div>
            </div>
            <section className="space-y-4 border-t px-4 py-5" style={{ borderColor: "var(--border)" }} aria-label="地面设置">
                <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold">地面</h3>
                    <Switch size="sm" aria-label="显示地面" checked={ground.visible} onChange={(visible) => updateGround({ visible })} />
                </div>
                <div className="space-y-1.5">
                    <div className="text-xs opacity-65">透明度</div>
                    <div className="flex items-center gap-3">
                        <Slider ariaLabelForHandle="地面透明度" className="m-0 min-w-0 flex-1" min={0} max={1} step={0.05} disabled={!ground.visible} value={ground.opacity} onChangeComplete={(opacity) => updateGround({ opacity })} />
                        <InputNumber aria-label="地面透明度数值" className="w-[72px] shrink-0" size="small" min={0} max={1} step={0.05} precision={2} disabled={!ground.visible} value={ground.opacity} onChange={(opacity) => { if (opacity !== null) updateGround({ opacity }); }} />
                    </div>
                </div>
                <div className="space-y-1.5">
                    <div className="text-xs opacity-65">高度</div>
                    <div className="flex items-center gap-3">
                        <Slider ariaLabelForHandle="地面高度" className="m-0 min-w-0 flex-1" min={-2} max={2} step={0.05} disabled={!ground.visible} value={ground.height} onChangeComplete={(height) => updateGround({ height })} />
                        <InputNumber aria-label="地面高度数值" className="w-[72px] shrink-0" size="small" min={-2} max={2} step={0.05} precision={1} disabled={!ground.visible} value={ground.height} onChange={(height) => { if (height !== null) updateGround({ height }); }} />
                    </div>
                </div>
            </section>
        </div>
    );
}
