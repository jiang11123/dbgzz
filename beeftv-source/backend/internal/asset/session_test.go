package asset

import (
	"bytes"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func putAllChunks(t *testing.T, svc *Service, userID, uploadID string, body []byte, chunkSize int) {
	t.Helper()
	for index, start := 0, 0; start < len(body); index++ {
		end := start + chunkSize
		if end > len(body) {
			end = len(body)
		}
		if err := svc.PutChunkedUpload(userID, uploadID, index, bytes.NewReader(body[start:end])); err != nil {
			t.Fatalf("put chunk %d: %v", index, err)
		}
		start = end
	}
}

func TestChunkedUploadStartEnforcesPerUserLimit(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	var started int
	var busy int
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(chunkUploadMaxPerUser + 1)
	for i := 0; i < chunkUploadMaxPerUser+1; i++ {
		go func() {
			defer wg.Done()
			_, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.bin", Kind: "file", Size: 1})
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				started++
				return
			}
			if !errors.Is(err, UploadSessionBusy()) && err.Error() != UploadSessionBusy().Error() {
				t.Errorf("start error = %v", err)
				return
			}
			busy++
		}()
	}
	wg.Wait()
	if started != chunkUploadMaxPerUser || busy != 1 {
		t.Fatalf("started=%d busy=%d", started, busy)
	}
}

func TestChunkedUploadIncompleteDoesNotReturnReady(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	resource, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err == nil || resource != nil {
		t.Fatalf("incomplete complete resource=%#v err=%v", resource, err)
	}
	listed, listErr := repo.Resources("user-1", 10)
	if listErr != nil || len(listed) != 0 {
		t.Fatalf("incomplete complete persisted %#v err=%v", listed, listErr)
	}
}

func TestChunkedUploadCompleteReplayAndCrossUser(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PutChunkedUpload("user-2", session.UploadID, 0, bytes.NewReader(body)); err == nil {
		t.Fatal("cross-user put succeeded")
	}
	if _, err := svc.CompleteChunkedUpload("user-2", session.UploadID); err == nil {
		t.Fatal("cross-user complete succeeded")
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	first, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("complete = %#v err=%v", first, err)
	}
	second, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || second == nil || second.ID != first.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("replay = %#v err=%v", second, err)
	}
}

func TestChunkedUploadReadySaveFailureDoesNotReturnReadyOrRefund(t *testing.T) {
	base, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	failing := &readySaveFailRepo{Repository: base.repo, remaining: 1}
	svc := NewService(Dependencies{
		Repository: failing,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	if quota.pendingTotal() != int64(len(body)) || quota.daily != int64(len(body)) {
		t.Fatalf("start quota pending=%d daily=%d", quota.pendingTotal(), quota.daily)
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	first, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err == nil || first != nil && first.Status == model.ResourceStatusReady {
		t.Fatalf("complete after ready-save fail resource=%#v err=%v", first, err)
	}
	listed, listErr := repo.Resources("user-1", 10)
	if listErr != nil || len(listed) != 1 || listed[0].Status == model.ResourceStatusReady {
		t.Fatalf("persisted after failed complete = %#v err=%v", listed, listErr)
	}
	if quota.daily != int64(len(body)) || quota.releases != 0 || quota.pendingTotal() != int64(len(body)) {
		t.Fatalf("ready-save fail refunded daily=%d pending=%d releases=%d", quota.daily, quota.pendingTotal(), quota.releases)
	}
	plantReservation(t, repo, "user-1", session.UploadID, int64(len(body)))
	second, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || second == nil || second.Status != model.ResourceStatusReady {
		t.Fatalf("complete replay after ready-save fail = %#v err=%v", second, err)
	}
	if quota.daily != int64(len(body)) || quota.releases != 0 || quota.pendingTotal() != 0 || quota.commits != 1 {
		t.Fatalf("after successful replay daily=%d pending=%d commits=%d releases=%d", quota.daily, quota.pendingTotal(), quota.commits, quota.releases)
	}
}

func TestChunkedUploadRestartExpiresAndReleasesAbandoned(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	first := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	session, err := first.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	if quota.daily != 7 || quota.pendingTotal() != 7 {
		t.Fatalf("start daily=%d pending=%d", quota.daily, quota.pendingTotal())
	}
	restarted := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if quota.daily != 0 || quota.pendingTotal() != 0 || quota.releases != 1 {
		t.Fatalf("restart leftover daily=%d pending=%d releases=%d", quota.daily, quota.pendingTotal(), quota.releases)
	}
	if _, err := restarted.CompleteChunkedUpload("user-1", session.UploadID); err == nil {
		t.Fatal("restart complete resumed expired session")
	}
	entries, _ := os.ReadDir(filepath.Join(dataDir, chunkSessionDirName))
	if len(entries) != 0 {
		t.Fatalf("temp session files remain: %v", entries)
	}
}

func TestChunkedUploadStartReservesAgainstGeneratedPending(t *testing.T) {
	base, _, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	svc := NewService(Dependencies{
		Repository: base.repo,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if _, err := quota.ReserveGenerated("user-1", 11, "generated-one"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7}); err != nil {
		t.Fatal(err)
	}
	if quota.pendingOf("generated-one") != 11 || quota.pendingTotal() != 18 {
		t.Fatalf("session stole generated pending %#v", quota.pending)
	}
}

func isAppError(err, target error) bool {
	return err != nil && target != nil && err.Error() == target.Error()
}

func TestChunkedUploadStartConflictsOnIdempotencyMismatch(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	req := ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7, Width: 1, Height: 1, IdempotencyKey: "same-key"}
	first, err := svc.StartChunkedUpload("user-1", req)
	if err != nil {
		t.Fatal(err)
	}
	reused, err := svc.StartChunkedUpload("user-1", req)
	if err != nil || reused.UploadID != first.UploadID {
		t.Fatalf("same request reuse = %#v err=%v", reused, err)
	}
	_, err = svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "b.png", Kind: "image", Size: 7, Width: 1, Height: 1, IdempotencyKey: "same-key"})
	if !isAppError(err, UploadConflict()) {
		t.Fatalf("live filename mismatch err=%v", err)
	}
	_, err = svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "file", Size: 7, Width: 1, Height: 1, IdempotencyKey: "same-key"})
	if !isAppError(err, UploadConflict()) {
		t.Fatalf("live kind mismatch err=%v", err)
	}
	_, err = svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 8, Width: 1, Height: 1, IdempotencyKey: "same-key"})
	if !isAppError(err, UploadConflict()) {
		t.Fatalf("live size mismatch err=%v", err)
	}
}

func TestChunkedUploadResumeReportsOnlyCompleteOwnedChunks(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	req := ChunkedUploadStart{FileName: "video.bin", Kind: "file", Size: ChunkUploadSize + 8, IdempotencyKey: "resume"}
	session, err := svc.StartChunkedUpload("user-1", req)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PutChunkedUpload("user-1", session.UploadID, 0, bytes.NewReader(make([]byte, ChunkUploadSize))); err != nil {
		t.Fatal(err)
	}
	if err := svc.PutChunkedUpload("user-1", session.UploadID, 1, bytes.NewReader([]byte("short"))); err == nil {
		t.Fatal("accepted incomplete chunk")
	}
	resumed, err := svc.StartChunkedUpload("user-1", req)
	if err != nil || resumed.UploadID != session.UploadID || len(resumed.Received) != 1 || resumed.Received[0] != 0 {
		t.Fatalf("resume=%+v err=%v", resumed, err)
	}
	other, err := svc.StartChunkedUpload("user-2", req)
	if err != nil || other.UploadID == session.UploadID || len(other.Received) != 0 {
		t.Fatalf("owner leaked: %+v err=%v", other, err)
	}
	if err := svc.PutChunkedUpload("user-1", session.UploadID, 1, bytes.NewReader([]byte("complete"))); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CompleteChunkedUpload("user-1", session.UploadID); err != nil {
		t.Fatal(err)
	}
	completed, err := svc.StartChunkedUpload("user-1", req)
	if err != nil || len(completed.Received) != 2 {
		t.Fatalf("completed=%+v err=%v", completed, err)
	}
}

func TestChunkedUploadCompletedStubConflictsOnIdempotencyMismatch(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	body := []byte("payload")
	req := ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body)), Width: 1, Height: 1, IdempotencyKey: "done-key"}
	session, err := svc.StartChunkedUpload("user-1", req)
	if err != nil {
		t.Fatal(err)
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	if _, err := svc.CompleteChunkedUpload("user-1", session.UploadID); err != nil {
		t.Fatal(err)
	}
	_, err = svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "other.png", Kind: "image", Size: int64(len(body)), Width: 1, Height: 1, IdempotencyKey: "done-key"})
	if !isAppError(err, UploadConflict()) {
		t.Fatalf("completed stub mismatch err=%v", err)
	}
	reused, err := svc.StartChunkedUpload("user-1", req)
	if err != nil || reused.UploadID == "" {
		t.Fatalf("completed stub same request err=%v %#v", err, reused)
	}
}

func TestChunkedUploadConcurrentSameIndexPublishesAtomically(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	const size = 32
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.bin", Kind: "file", Size: size})
	if err != nil {
		t.Fatal(err)
	}
	a := bytes.Repeat([]byte{0xAA}, size)
	b := bytes.Repeat([]byte{0xBB}, size)
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		if putErr := svc.PutChunkedUpload("user-1", session.UploadID, 0, bytes.NewReader(a)); putErr != nil {
			t.Errorf("put A: %v", putErr)
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		if putErr := svc.PutChunkedUpload("user-1", session.UploadID, 0, bytes.NewReader(b)); putErr != nil {
			t.Errorf("put B: %v", putErr)
		}
	}()
	close(start)
	wg.Wait()
	resource, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		t.Fatalf("complete = %#v err=%v", resource, err)
	}
	_, opened, err := svc.Open("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(opened)
	_ = opened.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, a) && !bytes.Equal(got, b) {
		t.Fatalf("mixed chunk bytes %x", got)
	}
}

func TestChunkedUploadTTLDoesNotDestroyInFlightPut(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	announced := make(chan struct{})
	hold := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- svc.PutChunkedUpload("user-1", session.UploadID, 0, &holdFirstRead{
			announced: announced,
			hold:      hold,
			rest:      bytes.NewReader(body),
		})
	}()
	<-announced
	if _, err := svc.StartChunkedUpload("user-2", ChunkedUploadStart{FileName: "b.png", Kind: "image", Size: 1}); err != nil {
		t.Fatalf("other start: %v", err)
	}
	close(hold)
	if err := <-done; err != nil {
		t.Fatalf("in-flight put: %v", err)
	}
	resource, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		t.Fatalf("complete after in-flight ttl = %#v err=%v", resource, err)
	}
}

func TestChunkedUploadPutRejectedWhileCompleting(t *testing.T) {
	base, _, dataDir := newTestDomain(t)
	announced := make(chan struct{})
	hold := make(chan struct{})
	blobs := &blockingBlob{BlobStore: base.blobs, announced: announced, hold: hold}
	svc := NewService(Dependencies{
		Repository: base.repo,
		Blobs:      blobs,
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	completeDone := make(chan error, 1)
	go func() {
		_, completeErr := svc.CompleteChunkedUpload("user-1", session.UploadID)
		completeDone <- completeErr
	}()
	<-announced
	putDone := make(chan error, 1)
	go func() {
		putDone <- svc.PutChunkedUpload("user-1", session.UploadID, 0, bytes.NewReader(bytes.Repeat([]byte{0xEE}, len(body))))
	}()
	close(hold)
	if err := <-completeDone; err != nil {
		t.Fatalf("complete: %v", err)
	}
	putErr := <-putDone
	if putErr != nil && !isAppError(putErr, UploadSessionCompleting()) {
		t.Fatalf("put during complete: %v", putErr)
	}
	resource, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil {
		t.Fatal(err)
	}
	_, opened, err := svc.Open("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(opened)
	_ = opened.Close()
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("complete delivered mutated bytes %q err=%v", got, err)
	}
}

type blockingBlob struct {
	BlobStore
	announced chan struct{}
	hold      chan struct{}
	once      sync.Once
}

func (b *blockingBlob) Write(objectKey string, body io.Reader) error {
	b.once.Do(func() {
		close(b.announced)
		<-b.hold
	})
	return b.BlobStore.Write(objectKey, body)
}

type lookupErrorRepo struct {
	Repository
}

func (r lookupErrorRepo) ResourceByUploadKey(string, string) (*model.Resource, error) {
	return nil, errors.New("injected lookup failure")
}

func (r lookupErrorRepo) ListUploadReservations() ([]model.UserUploadReservation, error) {
	return nil, errors.New("injected lookup failure")
}

func (r lookupErrorRepo) UploadReservation(string, string) (*model.UserUploadReservation, error) {
	return nil, errors.New("injected lookup failure")
}

func TestChunkedUploadAbandonFailsClosedOnLookupError(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	first := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if _, err := first.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7}); err != nil {
		t.Fatal(err)
	}
	NewService(Dependencies{
		Repository: lookupErrorRepo{Repository: NewRepository(repo)},
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if quota.daily != 7 || quota.releases != 0 || quota.pendingTotal() != 7 {
		t.Fatalf("lookup error released quota daily=%d pending=%d releases=%d", quota.daily, quota.pendingTotal(), quota.releases)
	}
	entries, _ := os.ReadDir(filepath.Join(dataDir, chunkSessionDirName))
	if len(entries) == 0 {
		t.Fatal("recovery evidence was deleted after lookup error")
	}
}

func TestNewServiceLogsReservationRecoveryFailure(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	var captured bytes.Buffer
	log.SetOutput(&captured)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	NewService(Dependencies{
		Repository: lookupErrorRepo{Repository: NewRepository(repo)},
		Blobs:      NewFileStore(dataDir),
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if !strings.Contains(captured.String(), "upload reservation recovery failed") {
		t.Fatalf("recovery error not logged: %q", captured.String())
	}
}

func TestChunkedUploadCorruptMetaIsKeptAndNotReleased(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	first := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	session, err := first.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(dataDir, chunkSessionDirName, session.UploadID, chunkSessionMetaName)
	if err := os.WriteFile(metaPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if quota.daily != 7 || quota.releases != 0 {
		t.Fatalf("corrupt meta released daily=%d releases=%d", quota.daily, quota.releases)
	}
	if _, err := os.Stat(filepath.Join(dataDir, chunkSessionDirName, session.UploadID)); err != nil {
		t.Fatalf("corrupt meta evidence missing: %v", err)
	}
}

func TestChunkedUploadPreparedMetaWithoutReserveDoesNotRelease(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	dir := filepath.Join(dataDir, chunkSessionDirName, "prepared-only")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(dir, chunkSessionMetaName, []byte(`{"id":"prepared-only","userId":"user-1","fileName":"a.png","kind":"image","size":7,"identity":"prepared-id","reserved":false,"chunkCount":1}`)); err != nil {
		t.Fatal(err)
	}
	NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if quota.releases != 0 || quota.daily != 0 {
		t.Fatalf("unreserved prepared meta released daily=%d releases=%d", quota.daily, quota.releases)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("unreserved prepared dir kept err=%v", err)
	}
}

func TestChunkedUploadRetryAfterDroppedSessionFilesCommits(t *testing.T) {
	base, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	failing := &readySaveFailRepo{Repository: base.repo, remaining: 1}
	svc := NewService(Dependencies{
		Repository: failing,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	first, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err == nil || first != nil && first.Status == model.ResourceStatusReady {
		t.Fatalf("complete after ready-save fail resource=%#v err=%v", first, err)
	}
	entries, _ := os.ReadDir(filepath.Join(dataDir, chunkSessionDirName, session.UploadID))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "chunk-") {
			t.Fatalf("chunk files remained after object was stored: %v", entries)
		}
	}
	if quota.pendingTotal() != int64(len(body)) || quota.commits != 0 {
		t.Fatalf("after drop pending=%d commits=%d", quota.pendingTotal(), quota.commits)
	}
	plantReservation(t, repo, "user-1", session.UploadID, int64(len(body)))
	second, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || second == nil || second.Status != model.ResourceStatusReady {
		t.Fatalf("retry after drop = %#v err=%v", second, err)
	}
	if quota.pendingTotal() != 0 || quota.commits != 1 || quota.releases != 0 {
		t.Fatalf("retry quota pending=%d commits=%d releases=%d", quota.pendingTotal(), quota.commits, quota.releases)
	}
	listed, listErr := repo.Resources("user-1", 10)
	if listErr != nil || len(listed) != 1 || listed[0].Status != model.ResourceStatusReady {
		t.Fatalf("persisted %#v err=%v", listed, listErr)
	}
}
