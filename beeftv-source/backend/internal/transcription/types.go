package transcription

import (
	"context"
	"io"
)

const BaseURLEnv = "CANVAS_WHISPER_BASE_URL"

type Segment struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
}

type Result struct {
	Segments []Segment `json:"segments"`
	SRT      string    `json:"srt"`
	Language string    `json:"language"`
}

type Media struct {
	MimeType string
}

// MediaOpener opens an authorized transcribable resource. Ownership stays in the adapter.
type MediaOpener interface {
	Open(ctx context.Context, resourceID string) (Media, io.ReadCloser, error)
}

// Progress reports transcribe stages. A nil Progress is ignored.
type Progress func(stage string, percent int) error
