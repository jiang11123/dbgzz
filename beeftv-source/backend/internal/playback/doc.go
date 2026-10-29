// Package playback owns browser-compatible playback copies of local videos.
//
// The domain probes MP4 codecs and generated-media dimensions, claims a
// transcode, runs ffmpeg, persists status, serves the copy for range reads,
// and recovers interrupted claims. It must not import internal/app.
// File bytes live under dataDir/playback; original media stays in the
// resource store. Background work uses the injected runtime-owned Runner;
// a refused Go releases the claim so a later preview request can retry. Transcode
// jobs observe a cancellation context and do not write READY after Stop.
package playback
