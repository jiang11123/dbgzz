package playback

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/model"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type cacheTestStore struct{ memStore }

type resetCopyFailStore struct{ cacheTestStore }

func (s *resetCopyFailStore) ResetPlaybackCopy(string, string, string) error {
	return errors.New("database unavailable")
}

func TestClearCacheResetFailurePreservesPlayableCopy(t *testing.T) {
	store := &resetCopyFailStore{}
	root := t.TempDir()
	path := filepath.Join(root, "playback", "mine.mp4")
	writeCodecMP4(t, path, "avc1")
	store.put(model.Resource{ID: "mine", UserID: "one", Status: model.ResourceStatusReady, Kind: "video", Provider: "local", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "mine.mp4"})
	svc := New(Deps{DataDir: root, Store: store})
	if n, err := svc.ClearCache("one"); n != 0 || err == nil {
		t.Fatalf("clear = %d %v", n, err)
	}
	stream, err := svc.OpenRange("one", "mine")
	if err != nil {
		t.Fatal("reset failure lost playable copy", err)
	}
	stream.Body.Close()
}

func TestPrepareRebuildsReadyRowWithMissingCopy(t *testing.T) {
	store := &cacheTestStore{}
	root := t.TempDir()
	writeCodecMP4(t, filepath.Join(root, "resources", "mine.mp4"), "hvc1")
	store.put(model.Resource{ID: "mine", UserID: "one", Status: model.ResourceStatusReady, Kind: "video", Provider: "local", ObjectKey: "mine.mp4", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "mine.mp4"})
	var calls int
	svc := New(Deps{DataDir: root, Store: store, Runner: syncRunner{}, LookPath: func(string) (string, error) { return "fixture", nil },
		Transcode: func(_ context.Context, _, dst string) error { calls++; writeCodecMP4(t, dst, "avc1"); return nil }})
	if _, err := svc.OpenRange("one", "mine"); !errors.Is(err, ErrNotReady) {
		t.Fatalf("missing copy = %v", err)
	}
	resource, _ := store.ResourceForUser("one", "mine")
	if err := svc.Prepare(resource); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("transcodes = %d", calls)
	}
	stream, err := svc.OpenRange("one", "mine")
	if err != nil {
		t.Fatal(err)
	}
	stream.Body.Close()
}

func (s *cacheTestStore) PlaybackCopiesForUser(userID string) ([]model.Resource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rows []model.Resource
	for _, r := range s.resources {
		if r.UserID == userID && r.Provider == "local" && r.Status == model.ResourceStatusReady && (r.PlaybackStatus == model.PlaybackStatusReady || r.PlaybackStatus == model.PlaybackStatusFailed) {
			rows = append(rows, *r)
		}
	}
	return rows, nil
}
func (s *cacheTestStore) ResetPlaybackCopy(userID, id, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.resources[id]; r != nil && r.UserID == userID && r.PlaybackObjectKey == key && r.PlaybackStatus != model.PlaybackStatusProcessing {
		r.PlaybackStatus = model.PlaybackStatusNone
		r.PlaybackObjectKey = ""
		r.PlaybackError = ""
	}
	return nil
}

func TestClearCachePreservesOriginalOtherUserAndInFlight(t *testing.T) {
	store := &cacheTestStore{}
	root := t.TempDir()
	svc := New(Deps{DataDir: root, Store: store})
	for _, item := range []struct{ id, user, status string }{{"mine", "one", model.PlaybackStatusReady}, {"other", "two", model.PlaybackStatusReady}, {"running", "one", model.PlaybackStatusProcessing}} {
		key := item.id + ".mp4"
		store.put(model.Resource{ID: item.id, UserID: item.user, Status: model.ResourceStatusReady, Kind: "video", Provider: "local", PlaybackStatus: item.status, PlaybackObjectKey: key, ObjectKey: key})
		for _, dir := range []string{"playback", "resources"} {
			if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, dir, key), []byte("original"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	if n, err := svc.ClearCache("one"); err != nil || n != 1 {
		t.Fatalf("clear = %d %v", n, err)
	}
	if _, err := os.Stat(filepath.Join(root, "playback", "mine.mp4")); !os.IsNotExist(err) {
		t.Fatal("own completed preview not removed")
	}
	for _, path := range []string{"resources/mine.mp4", "playback/other.mp4", "playback/running.mp4"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(path))); err != nil {
			t.Fatal(path, err)
		}
	}
	r, _ := store.ResourceForUser("one", "mine")
	if r.PlaybackStatus != model.PlaybackStatusNone || r.PlaybackObjectKey != "" {
		t.Fatal("cleared preview cannot be regenerated")
	}
}

type asyncTestRunner struct{ wg sync.WaitGroup }

func TestClearCacheRejectsAnotherResourcesCopyKey(t *testing.T) {
	store := &cacheTestStore{}
	root := t.TempDir()
	path := filepath.Join(root, "playback", "other.mp4")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("other user's preview"), 0o644); err != nil {
		t.Fatal(err)
	}
	store.put(model.Resource{ID: "mine", UserID: "one", Status: model.ResourceStatusReady, Kind: "video", Provider: "local", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "other.mp4"})
	if _, err := New(Deps{DataDir: root, Store: store}).ClearCache("one"); err == nil {
		t.Fatal("foreign key accepted")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("foreign preview removed", err)
	}
}

func (r *asyncTestRunner) Go(fn func(context.Context)) bool {
	r.wg.Add(1)
	go func() { defer r.wg.Done(); fn(context.Background()) }()
	return true
}

func TestPlaybackSerializesTranscodesAndReusesReadyCopy(t *testing.T) {
	store, runner := &memStore{}, &asyncTestRunner{}
	root := t.TempDir()
	var active, maxActive, calls atomic.Int32
	svc := New(Deps{DataDir: root, Store: store, Runner: runner, LookPath: func(string) (string, error) { return "fixture", nil }, Transcode: func(ctx context.Context, src, dst string) error {
		calls.Add(1)
		n := active.Add(1)
		if n > maxActive.Load() {
			maxActive.Store(n)
		}
		defer active.Add(-1)
		time.Sleep(10 * time.Millisecond)
		writeCodecMP4(t, dst, "avc1")
		return nil
	}})
	for _, id := range []string{"one", "two", "three"} {
		writeCodecMP4(t, filepath.Join(root, "resources", id+".mp4"), "hvc1")
		r := model.Resource{ID: id, UserID: "user", Status: model.ResourceStatusReady, Kind: "video", Provider: "local", ObjectKey: id + ".mp4"}
		store.put(r)
		svc.MaybeStart(&r)
	}
	runner.wg.Wait()
	if calls.Load() != 3 || maxActive.Load() != 1 {
		t.Fatalf("calls=%d concurrent=%d", calls.Load(), maxActive.Load())
	}
	r, _ := store.ResourceForUser("user", "one")
	svc.MaybeStart(r)
	runner.wg.Wait()
	if calls.Load() != 3 {
		t.Fatal("ready copy transcoded again")
	}
}
