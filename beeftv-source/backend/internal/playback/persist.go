package playback

import (
	"log"

	"infinite-canvas/backend/internal/model"
)

func withPersistRetry(op func() error) error {
	var err error
	for attempt := 1; attempt <= PersistAttempts; attempt++ {
		err = op()
		if err == nil {
			return nil
		}
	}
	return err
}

func finishPlayback(store Store, id, status, objectKey, errText, context string) (bool, error) {
	if store == nil || id == "" {
		return false, nil
	}
	var accepted bool
	err := withPersistRetry(func() error {
		ok, opErr := store.FinishPlaybackTranscode(id, status, objectKey, errText)
		if opErr != nil {
			return opErr
		}
		accepted = ok
		return nil
	})
	if err != nil {
		log.Printf("playback transcode persist failed: resource=%s context=%s attempts=%d error=%v", id, context, PersistAttempts, err)
		return false, err
	}
	return accepted, nil
}

func markNone(store Store, id, previous string) {
	if store == nil || id == "" {
		return
	}
	if previous == model.PlaybackStatusNone {
		return
	}
	err := withPersistRetry(func() error {
		_, opErr := store.MarkPlaybackNone(id)
		return opErr
	})
	if err != nil {
		log.Printf("playback mark none failed: resource=%s error=%v", id, err)
	}
}

func releaseClaim(store Store, id string) {
	if store == nil || id == "" {
		return
	}
	err := withPersistRetry(func() error {
		return store.ReleasePlaybackTranscodeClaim(id)
	})
	if err != nil {
		log.Printf("playback claim release failed: resource=%s error=%v", id, err)
	}
}
