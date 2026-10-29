import { type ReactNode } from "react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioPitchLabel, audioSpeedLabel, audioSpeechProfile, audioVolumeLabel, normalizeAudioFormatValue, normalizeAudioPitchValue, normalizeAudioSpeedValue, normalizeAudioVolumeValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioPitch" | "audioVolume" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[var(--panel-width-compact)] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const model = config.model || config.audioModel;
    const profile = audioSpeechProfile(model);
    const voice = normalizeAudioVoiceValue(config.audioVoice, model);
    const format = normalizeAudioFormatValue(config.audioFormat, model);
    const speed = normalizeAudioSpeedValue(config.audioSpeed, model);
    const pitch = normalizeAudioPitchValue(config.audioPitch);
    const volume = normalizeAudioVolumeValue(config.audioVolume);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                {profile.showVoice ? (
                    <SettingGroup title="音色" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {profile.voices.map((item) => (
                                <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                <SettingGroup title="格式" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {profile.formats.map((item) => (
                            <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {profile.showSpeed ? (
                    <SettingGroup title="语速" color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {profile.speedOptions.map((value) => (
                                <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                    {audioSpeedLabel(value, model)}
                                </OptionPill>
                            ))}
                        </div>
                        <input
                            type="number"
                            min={profile.speedMin}
                            max={profile.speedMax}
                            step={0.05}
                            className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                            value={config.audioSpeed || "1"}
                            onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                            onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value, model))}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
                {profile.showPitch ? (
                    <SettingGroup title="声调" color={theme.node.muted}>
                        <div className="flex items-center gap-2">
                            <input aria-label="声调" type="range" min={-12} max={12} step={1} className="min-w-0 flex-1 accent-current" value={pitch} onChange={(event) => onConfigChange("audioPitch", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            <span className="w-12 text-right text-xs tabular-nums">{audioPitchLabel(pitch)}</span>
                        </div>
                    </SettingGroup>
                ) : null}
                {profile.showVolume ? (
                    <SettingGroup title="音量" color={theme.node.muted}>
                        <div className="flex items-center gap-2">
                            <input aria-label="音量" type="range" min={0} max={1} step={0.05} className="min-w-0 flex-1 accent-current" value={volume} onChange={(event) => onConfigChange("audioVolume", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            <span className="w-12 text-right text-xs tabular-nums">{audioVolumeLabel(volume)}</span>
                        </div>
                    </SettingGroup>
                ) : null}
                {profile.showInstructions ? (
                    <SettingGroup title="声音指令" color={theme.node.muted}>
                        <textarea
                            value={config.audioInstructions || ""}
                            placeholder="例如：自然、温暖、适合旁白。"
                            className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
