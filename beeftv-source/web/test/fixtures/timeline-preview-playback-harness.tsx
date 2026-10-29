import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTimelinePreviewPlayback } from "@/hooks/use-timeline-preview-playback";
import { CanvasTimelinePreview } from "@/components/canvas/canvas-timeline-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";

const slowRaf = new URLSearchParams(location.search).has("slowRaf");
if (slowRaf) {
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 240);
    window.cancelAnimationFrame = handle => window.clearTimeout(handle);
}

const audioElements: HTMLAudioElement[] = [];
const NativeAudio = window.Audio;
window.Audio = function (...args: ConstructorParameters<typeof Audio>) { const audio = new NativeAudio(...args); audioElements.push(audio); return audio; } as typeof Audio;
const tracks: TimelineTrack[] = ["video", "voice", "music", "captions"].map((id, order) => ({ id, kind: id === "voice" || id === "music" ? "audio" : id === "captions" ? "subtitle" : "video", label: id, order }));
const clips: TimelineClip[] = [
    { id: "video", kind: "video", nodeId: "", trackId: "video", startMs: 0, durationMs: 2400, sourceStartMs: 300, volume: 0.6, directMedia: { id: "movie", kind: "video", title: "movie", url: "/video.mp4" } },
    { id: "voice", kind: "audio", nodeId: "", trackId: "voice", startMs: 200, durationMs: 1600, sourceStartMs: 600, volume: 0.4, fadeInMs: 400, fadeOutMs: 400, directMedia: { id: "voice", kind: "audio", title: "voice", content: "/voice.wav" } },
    { id: "music", kind: "audio", nodeId: "", trackId: "music", startMs: 600, durationMs: 1600, sourceStartMs: 400, volume: 0.6, directMedia: { id: "music", kind: "audio", title: "music", dataUrl: "/music.wav" } },
    { id: "caption", kind: "subtitle", nodeId: "", trackId: "captions", startMs: 600, durationMs: 1600, text: "今夜花香未散，晚安" },
];

function Harness() {
    const [projectClips, setClips] = useState(() => slowRaf ? clips.map(clip => clip.id === "voice" ? { ...clip, startMs: 600, sourceStartMs: 2400 } : clip.id === "video" ? { ...clip, sourceStartMs: 1600 } : clip) : clips);
    const [projectTracks, setTracks] = useState(tracks);
    const [playhead, setPlayhead] = useState(slowRaf ? 0 : 1000);
    const [playing, setPlaying] = useState(false);
    const [burn, setBurn] = useState(true);
    const [error, setError] = useState("");
    const previewMode = new URLSearchParams(location.search).has("preview");
    const videoRef = useRef<HTMLVideoElement>(null);
    const active = projectClips.find(clip => clip.kind === "video" && playhead >= clip.startMs && playhead < clip.startMs + clip.durationMs);
    const { syncVideoMetadata } = useTimelinePreviewPlayback({ clips: previewMode ? [] : projectClips, tracks: projectTracks, nodes: [], playheadMs: playhead, playing, videoRef, activeVideoClipId: active?.id || null, onPlayheadChange: setPlayhead, onRequestPause: () => setPlaying(false), onPlaybackError: setError });
    Object.assign(window, { timelinePlaybackFixture: {
        seek: setPlayhead, burn: setBurn,
        audioOnly: () => setClips(previous => previous.filter(clip => clip.kind !== "video")),
        gap: () => setClips(previous => previous.map(clip => clip.kind === "video" ? { ...clip, startMs: 1600, durationMs: 800 } : clip)),
        mute: (value: boolean) => setTracks(previous => previous.map(track => track.id === "voice" ? { ...track, muted: value } : track)),
        muteVideo: (value: boolean) => setTracks(previous => previous.map(track => track.id === "video" ? { ...track, muted: value } : track)),
        hide: (value: boolean) => setTracks(previous => previous.map(track => track.id === "music" ? { ...track, visible: !value } : track)),
        removeVoice: () => setClips(previous => previous.filter(clip => clip.id !== "voice")),
        snapshot: () => ({ playing, playhead, error, audio: audioElements.map(audio => ({ src: audio.getAttribute("src"), currentTime: audio.currentTime, paused: audio.paused, muted: audio.muted, volume: audio.volume, readyState: audio.readyState, error: audio.error?.code || null })) }),
    } });
    return <main><button onClick={() => { setError(""); setPlaying(value => !value); }}>{playing ? "Pause" : "Play"}</button><output>{Math.round(playhead)}</output>{error ? <div role="alert">{error}</div> : null}
        {previewMode ? <CanvasTimelinePreview clips={projectClips} tracks={projectTracks} nodes={[]} output={{ width: 480, height: 854, fps: 24, burnSubtitles: burn }} playheadMs={playhead} playing={false} theme={Object.values(canvasThemes)[0]} onTogglePlay={() => {}} onPlayheadChange={setPlayhead} onRequestPause={() => setPlaying(false)} /> : <video data-playback-video ref={videoRef} src="/video.mp4" preload="auto" onLoadedMetadata={syncVideoMetadata} />}
    </main>;
}
const root = createRoot(document.getElementById("root")!);
Object.assign(window, { unmountTimelinePlaybackFixture: () => root.unmount() });
root.render(<Harness />);
