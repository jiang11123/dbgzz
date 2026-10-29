package editing

import "fmt"

// SourceFacts is the authorized probe result for one opaque source id.
type SourceFacts struct {
	HasAudio   bool
	HasVideo   bool
	DurationMs int64
}

// ApplySourceFacts binds probe results onto an already compiled plan.
// It updates HasAudio and rejects missing tracks or crops past source duration.
// It does not re-select, reorder, or drop planned clips.
func ApplySourceFacts(plan *Plan, facts map[string]SourceFacts) error {
	if plan == nil {
		return ErrNoMedia
	}
	for i := range plan.Segments {
		seg := &plan.Segments[i]
		if seg.Kind == KindGap {
			seg.HasAudio = false
			continue
		}
		fact, ok := facts[seg.SourceID]
		if !ok {
			return fmt.Errorf("%w：%s", ErrMissingSource, seg.ClipID)
		}
		switch seg.Kind {
		case KindImage:
			seg.HasAudio = false
		case KindVideo:
			if !fact.HasVideo {
				return fmt.Errorf("%w：%s", ErrMissingVideoTrack, seg.ClipID)
			}
			if fact.DurationMs <= 0 {
				return fmt.Errorf("%w：%s", ErrUnreadableSource, seg.ClipID)
			}
			if seg.SourceStartMs+seg.DurationMs > fact.DurationMs+DurationToleranceMs {
				return fmt.Errorf("%w：%s", ErrInsufficientDuration, seg.ClipID)
			}
			seg.HasAudio = fact.HasAudio && !seg.Muted
		}
	}
	for i := range plan.Audio {
		clip := &plan.Audio[i]
		fact, ok := facts[clip.SourceID]
		if !ok {
			return fmt.Errorf("%w：%s", ErrMissingSource, clip.ClipID)
		}
		if !fact.HasAudio {
			return ErrMissingAudioTrack
		}
		if fact.DurationMs <= 0 {
			return fmt.Errorf("%w：%s", ErrUnreadableSource, clip.ClipID)
		}
		if clip.SourceStartMs+clip.DurationMs > fact.DurationMs+DurationToleranceMs {
			return fmt.Errorf("%w：%s", ErrInsufficientDuration, clip.ClipID)
		}
	}
	return nil
}
