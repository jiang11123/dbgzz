// Package editing owns the versioned semantic timeline render plan.
//
// Compile decides selection, order, gaps, crop offsets, duration, mute, gain,
// fades, subtitles and output dimensions. Native ffmpeg and browser wasm may
// lower the same plan into different command graphs; they must not choose or
// drop content on their own. Source IDs are opaque (resource id / node id);
// this package never accepts native filesystem paths or raw ffmpeg arguments.
package editing

import (
	"encoding/json"
	"strings"
)

const (
	PlanVersion               = 1
	ProjectVersion            = 2
	DefaultWidth              = 1920
	DefaultHeight             = 1080
	DefaultFPS                = 30
	DefaultSampleRate         = 44100
	MaxWidth                  = 7680
	MaxHeight                 = 4320
	MinFPS                    = 1
	MaxFPS                    = 120
	MinSampleRate             = 8000
	MaxSampleRate             = 96000
	MaxDurationMs             = 12 * 60 * 60 * 1000
	DurationToleranceMs       = 100
	OutputDurationToleranceMs = 250
	KindVideo                 = "video"
	KindImage                 = "image"
	KindAudio                 = "audio"
	KindSubtitle              = "subtitle"
	KindGap                   = "gap"
)

// Project is the TimelineProject v2 snapshot shared with the frontend.
type Project struct {
	Version    int      `json:"version"`
	Tracks     []Track  `json:"tracks"`
	Clips      []Clip   `json:"clips"`
	DurationMs int64    `json:"durationMs"`
	Output     *Options `json:"output,omitempty"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
}

type Track struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Visible *bool  `json:"visible"`
	Muted   bool   `json:"muted"`
	Label   string `json:"label,omitempty"`
	Order   *int   `json:"order,omitempty"`
	Locked  bool   `json:"locked,omitempty"`
}

type Clip struct {
	ID                 string       `json:"id"`
	Kind               string       `json:"kind"`
	NodeID             string       `json:"nodeId"`
	TrackID            string       `json:"trackId"`
	StartMs            int64        `json:"startMs"`
	DurationMs         int64        `json:"durationMs"`
	SourceStartMs      int64        `json:"sourceStartMs"`
	SourceDurationMs   int64        `json:"sourceDurationMs"`
	Volume             float64      `json:"volume"`
	FadeInMs           int64        `json:"fadeInMs"`
	FadeOutMs          int64        `json:"fadeOutMs"`
	Text               string       `json:"text"`
	DirectMedia        *DirectMedia `json:"directMedia"`
	Title              string       `json:"title,omitempty"`
	SubtitleEntryIndex *int         `json:"subtitleEntryIndex,omitempty"`
}

// Volume 缺省为 1；显式的 0 必须保留为静音。
func (clip *Clip) UnmarshalJSON(data []byte) error {
	type plain Clip
	value := plain{Volume: 1}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*clip = Clip(value)
	return nil
}

type DirectMedia struct {
	ID         string `json:"id"`
	AssetID    string `json:"assetId,omitempty"`
	Kind       string `json:"kind"`
	StorageKey string `json:"storageKey"`
}

// SourceMeta is client- or probe-supplied capability data. IDs are opaque;
// Path/URL fields are intentionally absent so callers cannot smuggle native paths.
type SourceMeta struct {
	ID         string `json:"id"`
	Kind       string `json:"kind,omitempty"`
	HasAudio   *bool  `json:"hasAudio,omitempty"`
	HasVideo   *bool  `json:"hasVideo,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
}

type Options struct {
	Width         int   `json:"width"`
	Height        int   `json:"height"`
	FPS           int   `json:"fps"`
	SampleRate    int   `json:"sampleRate"`
	BurnSubtitles *bool `json:"burnSubtitles"`
}

type Output struct {
	Width         int  `json:"width"`
	Height        int  `json:"height"`
	FPS           int  `json:"fps"`
	SampleRate    int  `json:"sampleRate"`
	BurnSubtitles bool `json:"burnSubtitles"`
}

// Plan is the versioned semantic timeline render plan.
type Plan struct {
	Version     int         `json:"version"`
	Output      Output      `json:"output"`
	DurationMs  int64       `json:"durationMs"`
	Segments    []Segment   `json:"segments"`
	Audio       []AudioClip `json:"audio"`
	Subtitles   []Subtitle  `json:"subtitles"`
	SubtitleSRT string      `json:"subtitleSrt,omitempty"`
}

type Segment struct {
	Kind          string  `json:"kind"`
	ClipID        string  `json:"clipId,omitempty"`
	SourceID      string  `json:"sourceId,omitempty"`
	StartMs       int64   `json:"startMs"`
	DurationMs    int64   `json:"durationMs"`
	SourceStartMs int64   `json:"sourceStartMs,omitempty"`
	Volume        float64 `json:"volume"`
	FadeInMs      int64   `json:"fadeInMs,omitempty"`
	FadeOutMs     int64   `json:"fadeOutMs,omitempty"`
	Muted         bool    `json:"muted,omitempty"`
	HasAudio      bool    `json:"hasAudio"`
}

type AudioClip struct {
	ClipID        string  `json:"clipId"`
	SourceID      string  `json:"sourceId"`
	StartMs       int64   `json:"startMs"`
	DurationMs    int64   `json:"durationMs"`
	SourceStartMs int64   `json:"sourceStartMs"`
	Volume        float64 `json:"volume"`
	FadeInMs      int64   `json:"fadeInMs,omitempty"`
	FadeOutMs     int64   `json:"fadeOutMs,omitempty"`
	Muted         bool    `json:"muted,omitempty"`
}

type Subtitle struct {
	ClipID     string `json:"clipId"`
	StartMs    int64  `json:"startMs"`
	DurationMs int64  `json:"durationMs"`
	Text       string `json:"text"`
}

func DefaultOptions() Options {
	burn := true
	return Options{Width: DefaultWidth, Height: DefaultHeight, FPS: DefaultFPS, SampleRate: DefaultSampleRate, BurnSubtitles: &burn}
}

// NormalizeOptions fills omitted output fields, then rejects encoder-impossible values.
func NormalizeOptions(opts Options) (Options, error) {
	if opts.Width == 0 {
		opts.Width = DefaultWidth
	}
	if opts.Height == 0 {
		opts.Height = DefaultHeight
	}
	if opts.FPS == 0 {
		opts.FPS = DefaultFPS
	}
	if opts.SampleRate == 0 {
		opts.SampleRate = DefaultSampleRate
	}
	if opts.BurnSubtitles == nil {
		burn := true
		opts.BurnSubtitles = &burn
	}
	if opts.Width < 2 || opts.Width > MaxWidth || opts.Width%2 != 0 {
		return opts, ErrInvalidOutput
	}
	if opts.Height < 2 || opts.Height > MaxHeight || opts.Height%2 != 0 {
		return opts, ErrInvalidOutput
	}
	if opts.FPS < MinFPS || opts.FPS > MaxFPS {
		return opts, ErrInvalidOutput
	}
	if opts.SampleRate < MinSampleRate || opts.SampleRate > MaxSampleRate {
		return opts, ErrInvalidOutput
	}
	return opts, nil
}

func (p Plan) HasMedia() bool {
	for _, seg := range p.Segments {
		if seg.Kind != KindGap {
			return true
		}
	}
	return len(p.Audio) > 0
}

func (p Plan) VisualSourceIDs() []string {
	seen := map[string]bool{}
	var ids []string
	for _, seg := range p.Segments {
		if seg.Kind == KindGap || seg.SourceID == "" || seen[seg.SourceID] {
			continue
		}
		seen[seg.SourceID] = true
		ids = append(ids, seg.SourceID)
	}
	for _, clip := range p.Audio {
		if clip.SourceID == "" || seen[clip.SourceID] {
			continue
		}
		seen[clip.SourceID] = true
		ids = append(ids, clip.SourceID)
	}
	return ids
}

func (p Plan) SourceIDs() []string {
	return p.VisualSourceIDs()
}

// MediaResourceID 从片段的 directMedia.storageKey（resource:<id>）还原资源 ID。
func MediaResourceID(clip Clip) (string, bool) {
	if clip.DirectMedia == nil {
		return "", false
	}
	key := strings.TrimSpace(clip.DirectMedia.StorageKey)
	if !strings.HasPrefix(key, "resource:") {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(key, "resource:"))
	return id, id != ""
}
