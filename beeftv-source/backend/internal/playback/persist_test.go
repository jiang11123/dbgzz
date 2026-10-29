package playback

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type failingStore struct {
	failTimes int
	calls     int
	memStore
}

func (s *failingStore) FinishPlaybackTranscode(id, status, objectKey, errText string) (bool, error) {
	s.calls++
	if s.calls <= s.failTimes {
		return false, errors.New("db busy")
	}
	return s.memStore.FinishPlaybackTranscode(id, status, objectKey, errText)
}

func TestFinishPlaybackRetriesThenSucceeds(t *testing.T) {
	store := &failingStore{failTimes: 2}
	store.put(model.Resource{
		ID: "r1", Status: model.ResourceStatusReady, PlaybackStatus: model.PlaybackStatusProcessing,
	})
	ok, err := finishPlayback(store, "r1", model.PlaybackStatusReady, "r1.mp4", "", "test")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if store.calls != PersistAttempts {
		t.Fatalf("calls = %d, want %d", store.calls, PersistAttempts)
	}
}

func TestFinishPlaybackReturnsAfterExhaustedRetries(t *testing.T) {
	store := &failingStore{failTimes: 10}
	store.put(model.Resource{
		ID: "r1", Status: model.ResourceStatusReady, PlaybackStatus: model.PlaybackStatusProcessing,
	})
	ok, err := finishPlayback(store, "r1", model.PlaybackStatusReady, "r1.mp4", "", "test")
	if err == nil || ok {
		t.Fatal("expected persist error")
	}
	if store.calls != PersistAttempts {
		t.Fatalf("calls = %d, want %d", store.calls, PersistAttempts)
	}
}

func TestFinishPlaybackDoesNotResurrectNonReadyRow(t *testing.T) {
	store := &memStore{}
	store.put(model.Resource{
		ID: "gone", Status: model.ResourceStatusPending, PlaybackStatus: model.PlaybackStatusProcessing,
	})
	ok, err := finishPlayback(store, "gone", model.PlaybackStatusReady, "gone.mp4", "", "test")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("finish accepted a row that is no longer READY")
	}
	got := store.get("gone")
	if got.PlaybackStatus != model.PlaybackStatusProcessing || got.Status != model.ResourceStatusPending {
		t.Fatalf("row = %+v", got)
	}
}

func TestFinishPlaybackDoesNotResurrectDeletedRow(t *testing.T) {
	store := &memStore{}
	ok, err := finishPlayback(store, "missing", model.PlaybackStatusReady, "missing.mp4", "", "test")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("finish accepted a missing row")
	}
}
