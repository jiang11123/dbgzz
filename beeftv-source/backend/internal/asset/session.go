package asset

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

const (
	ChunkUploadSize       = 8 << 20
	chunkUploadSlackBytes = 64 << 10
	chunkUploadTTL        = 90 * time.Minute
	chunkUploadMaxPerUser = 32
	chunkSessionMetaName  = "meta.json"
	chunkSessionDirName   = "chunk-sessions"
)

type ChunkedUploadStart struct {
	FileName       string
	Kind           string
	Size           int64
	Width          int
	Height         int
	DurationMs     int64
	IdempotencyKey string
}

type ChunkedUploadSessionInfo struct {
	UploadID   string
	ChunkSize  int
	ChunkCount int
	Received   []int
}

type chunkedUploadSession struct {
	mu          sync.Mutex
	ID          string
	UserID      string
	FileName    string
	Kind        string
	Size        int64
	Width       int
	Height      int
	DurationMs  int64
	Identity    string
	Day         string
	Reserved    bool
	ChunkCount  int
	Dir         string
	CreatedAt   time.Time
	completing  bool
	complete    *model.Resource
	completeErr error
}

type chunkSessionMeta struct {
	ID         string    `json:"id"`
	UserID     string    `json:"userId"`
	FileName   string    `json:"fileName"`
	Kind       string    `json:"kind"`
	Size       int64     `json:"size"`
	Width      int       `json:"width"`
	Height     int       `json:"height"`
	DurationMs int64     `json:"durationMs"`
	Identity   string    `json:"identity"`
	Day        string    `json:"day"`
	Reserved   bool      `json:"reserved"`
	ChunkCount int       `json:"chunkCount"`
	CreatedAt  time.Time `json:"createdAt"`
}

func (s *Service) sessionRoot() string {
	if s == nil || strings.TrimSpace(s.dataDir) == "" {
		return ""
	}
	return filepath.Join(s.dataDir, chunkSessionDirName)
}

func newUploadSessionID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func chunkedIdentity(sessionID, idempotencyKey string) string {
	if key := NormalizedUploadKey([]string{idempotencyKey}); key != nil {
		return *key
	}
	return strings.TrimSpace(sessionID)
}

func (sess *chunkedUploadSession) chunkPath(index int) string {
	return filepath.Join(sess.Dir, fmt.Sprintf("chunk-%d", index))
}

func (sess *chunkedUploadSession) chunkSizeAt(index int) int64 {
	if sess == nil || index < 0 || index >= sess.ChunkCount {
		return 0
	}
	if index == sess.ChunkCount-1 {
		rest := sess.Size - int64(index)*ChunkUploadSize
		if rest < 0 {
			return 0
		}
		return rest
	}
	return ChunkUploadSize
}

func (sess *chunkedUploadSession) hasAllChunks() bool {
	if sess == nil || sess.Dir == "" {
		return false
	}
	for i := 0; i < sess.ChunkCount; i++ {
		info, err := os.Stat(sess.chunkPath(i))
		if err != nil || info.Size() != sess.chunkSizeAt(i) {
			return false
		}
	}
	return true
}

func (sess *chunkedUploadSession) info() ChunkedUploadSessionInfo {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	info := ChunkedUploadSessionInfo{UploadID: sess.ID, ChunkSize: ChunkUploadSize, ChunkCount: sess.ChunkCount, Received: []int{}}
	for index := 0; index < sess.ChunkCount; index++ {
		if sess.complete != nil {
			info.Received = append(info.Received, index)
		} else if sess.Dir != "" {
			if stat, err := os.Stat(sess.chunkPath(index)); err == nil && stat.Mode().IsRegular() && stat.Size() == sess.chunkSizeAt(index) {
				info.Received = append(info.Received, index)
			}
		}
	}
	return info
}

func (sess *chunkedUploadSession) matchesRequest(req ChunkedUploadStart) bool {
	if sess == nil {
		return false
	}
	return sess.FileName == strings.TrimSpace(req.FileName) &&
		NormalizeKind(sess.Kind, "") == NormalizeKind(req.Kind, "") &&
		sess.Size == req.Size &&
		sess.Width == req.Width &&
		sess.Height == req.Height &&
		sess.DurationMs == req.DurationMs
}

func resourceMatchesRequest(resource *model.Resource, req ChunkedUploadStart) error {
	if resource == nil {
		return nil
	}
	if resource.Size != req.Size || resource.Kind != NormalizeKind(req.Kind, resource.MimeType) {
		return UploadConflict()
	}
	if resource.Width != req.Width || resource.Height != req.Height || resource.DurationMs != req.DurationMs {
		return UploadConflict()
	}
	return nil
}

func (s *Service) StartChunkedUpload(userID string, req ChunkedUploadStart) (ChunkedUploadSessionInfo, error) {
	if s == nil || s.repo == nil {
		return ChunkedUploadSessionInfo{}, ResourceMissing()
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ChunkedUploadSessionInfo{}, ResourceMissing()
	}
	req.FileName = strings.TrimSpace(req.FileName)
	if req.FileName == "" || len(req.FileName) > 255 {
		return ChunkedUploadSessionInfo{}, kernel.BadAuthRequest("文件名不能为空且不能超过 255 个字符")
	}
	if req.Size <= 0 {
		return ChunkedUploadSessionInfo{}, kernel.BadAuthRequest("文件大小必须大于 0")
	}
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	s.expireSessionsLocked(time.Now())
	if err := s.reconcileSessionDirsLocked(); err != nil {
		return ChunkedUploadSessionInfo{}, UploadSessionRecoveryFailed()
	}
	identity := chunkedIdentity("", req.IdempotencyKey)
	if identity != "" {
		if existing := s.liveSessionByIdentityLocked(userID, identity); existing != nil {
			if !existing.matchesRequest(req) {
				return ChunkedUploadSessionInfo{}, UploadConflict()
			}
			return existing.info(), nil
		}
		existing, err := s.resourceForUploadKey(userID, &identity)
		if err != nil {
			return ChunkedUploadSessionInfo{}, err
		}
		if existing != nil {
			if matchErr := resourceMatchesRequest(existing, req); matchErr != nil {
				return ChunkedUploadSessionInfo{}, matchErr
			}
			if existing.Status == model.ResourceStatusReady {
				stub := s.rememberCompletedLocked(userID, identity, existing, req)
				return stub.info(), nil
			}
		}
	}
	active := 0
	for _, sess := range s.sessions {
		if sess != nil && sess.UserID == userID {
			sess.mu.Lock()
			if sess.complete == nil {
				active++
			}
			sess.mu.Unlock()
		}
	}
	if active >= chunkUploadMaxPerUser {
		return ChunkedUploadSessionInfo{}, UploadSessionBusy()
	}
	sessionID := newUploadSessionID()
	if identity == "" {
		identity = sessionID
	}
	existing, err := s.resourceForUploadKey(userID, &identity)
	if err != nil {
		return ChunkedUploadSessionInfo{}, err
	}
	if existing != nil {
		if matchErr := resourceMatchesRequest(existing, req); matchErr != nil {
			return ChunkedUploadSessionInfo{}, matchErr
		}
	}
	dir, err := s.createSessionDir(sessionID)
	if err != nil {
		return ChunkedUploadSessionInfo{}, err
	}
	chunkCount := int((req.Size + ChunkUploadSize - 1) / ChunkUploadSize)
	sess := &chunkedUploadSession{
		ID: sessionID, UserID: userID, FileName: req.FileName, Kind: req.Kind,
		Size: req.Size, Width: req.Width, Height: req.Height, DurationMs: req.DurationMs,
		Identity: identity, ChunkCount: chunkCount, Dir: dir, CreatedAt: time.Now(),
	}
	if err := writeSessionMeta(sess); err != nil {
		_ = os.RemoveAll(dir)
		return ChunkedUploadSessionInfo{}, err
	}
	if existing == nil {
		day, reserveErr := s.reserveChunked(userID, req.Size, identity)
		if reserveErr != nil {
			_ = os.RemoveAll(dir)
			return ChunkedUploadSessionInfo{}, reserveErr
		}
		sess.Day = day
		sess.Reserved = true
		if err := writeSessionMeta(sess); err != nil {
			s.quotaRelease(userID, day, req.Size, identity)
			_ = os.RemoveAll(dir)
			return ChunkedUploadSessionInfo{}, err
		}
	}
	s.sessions[sessionID] = sess
	return sess.info(), nil
}

func (s *Service) PutChunkedUpload(userID, uploadID string, index int, body io.Reader) error {
	if s == nil {
		return UploadSessionMissing()
	}
	userID = strings.TrimSpace(userID)
	s.sessionMu.Lock()
	s.expireSessionsLocked(time.Now())
	sess := s.sessions[strings.TrimSpace(uploadID)]
	if sess == nil {
		s.sessionMu.Unlock()
		return UploadSessionMissing()
	}
	sess.mu.Lock()
	s.sessionMu.Unlock()
	defer sess.mu.Unlock()
	if sess.UserID != userID {
		return UploadSessionMissing()
	}
	if sess.complete != nil {
		return nil
	}
	if sess.completing {
		return UploadSessionCompleting()
	}
	if sess.Dir == "" {
		return UploadSessionMissing()
	}
	if err := sess.publishChunk(index, body); err != nil {
		return err
	}
	sess.CreatedAt = time.Now()
	_ = writeSessionMeta(sess)
	return nil
}

func (sess *chunkedUploadSession) publishChunk(index int, body io.Reader) error {
	expected := sess.chunkSizeAt(index)
	if expected <= 0 {
		return UploadChunkIndexInvalid()
	}
	temporary, err := os.CreateTemp(sess.Dir, fmt.Sprintf(".chunk-%d-*", index))
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanupTemp := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanupTemp()
		return err
	}
	limited := &io.LimitedReader{R: body, N: expected + chunkUploadSlackBytes + 1}
	written, copyErr := io.CopyN(temporary, limited, expected)
	if copyErr != nil || written != expected {
		cleanupTemp()
		return UploadChunkIncomplete(index)
	}
	var probe [1]byte
	if extra, readErr := limited.Read(probe[:]); readErr == nil || extra > 0 {
		cleanupTemp()
		return UploadChunkTooLarge(index)
	}
	if err := temporary.Sync(); err != nil {
		cleanupTemp()
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := os.Rename(temporaryPath, sess.chunkPath(index)); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := syncDirectory(sess.Dir); err != nil {
		_ = os.Remove(sess.chunkPath(index))
		return err
	}
	return nil
}

func (s *Service) CompleteChunkedUpload(userID, uploadID string) (*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	userID = strings.TrimSpace(userID)
	uploadID = strings.TrimSpace(uploadID)
	s.sessionMu.Lock()
	s.expireSessionsLocked(time.Now())
	sess := s.sessions[uploadID]
	if sess == nil || sess.UserID != userID {
		s.sessionMu.Unlock()
		return s.completeMissingSession(userID, uploadID)
	}
	sess.mu.Lock()
	s.sessionMu.Unlock()
	defer sess.mu.Unlock()
	if sess.complete != nil {
		return sess.complete, nil
	}
	sess.completing = true
	resource, err := s.completeSessionWork(sess)
	if err == nil && resource != nil && resource.Status == model.ResourceStatusReady {
		sess.complete = resource
		sess.completeErr = nil
		s.dropSessionFilesLocked(sess)
		sess.completing = false
		return resource, nil
	}
	sess.completeErr = err
	sess.completing = false
	if resource != nil && s.objectPresent(resource) {
		s.dropSessionFilesLocked(sess)
	}
	if err != nil {
		return nil, err
	}
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return nil, UploadSessionIncomplete()
	}
	return resource, nil
}

func (s *Service) completeMissingSession(userID, uploadID string) (*model.Resource, error) {
	if ready, err := s.readyResourceByIdentity(userID, uploadID); err != nil {
		return nil, err
	} else if ready != nil {
		if commitErr := s.commitWitness(userID, quotaIdentity(ready.UploadKey, ready.ID), ready.Size); commitErr != nil {
			return nil, commitErr
		}
		return ready, nil
	}
	return nil, UploadSessionMissing()
}

func (s *Service) completeSessionWork(sess *chunkedUploadSession) (*model.Resource, error) {
	if sess == nil {
		return nil, UploadSessionMissing()
	}
	identity := sess.Identity
	uploadKey := identity
	existing, err := s.resourceForUploadKey(sess.UserID, &uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.Status == model.ResourceStatusReady {
			if commitErr := s.commitWitness(sess.UserID, identity, sess.Size); commitErr != nil {
				return nil, commitErr
			}
			return existing, nil
		}
		if s.objectPresent(existing) {
			resource, err := s.promoteReady(existing, func() (string, error) {
				return s.reserveRetry(existing.UserID, existing.Size, identity)
			})
			if err == nil && resource != nil && resource.Status == model.ResourceStatusReady {
				if commitErr := s.commitWitness(sess.UserID, identity, sess.Size); commitErr != nil {
					return resource, commitErr
				}
			}
			return resource, err
		}
		body, err := s.openSessionBody(sess)
		if err != nil {
			return nil, err
		}
		defer closeAssembled(body)
		resource, err := s.RetryOwned(sess.UserID, existing.ID, existing.Kind, existing.MimeType, sess.Size, body)
		if err == nil && resource != nil && resource.Status == model.ResourceStatusReady {
			s.quotaCommit(sess.UserID, sess.Size, identity)
		}
		return resource, err
	}
	body, err := s.openSessionBody(sess)
	if err != nil {
		return nil, err
	}
	defer closeAssembled(body)
	mimeType := DetectUploadedMimeType(body, sess.FileName, "")
	_, _ = body.Seek(0, io.SeekStart)
	resource, created, err := s.Store(sess.UserID, sess.Kind, sess.FileName, mimeType, sess.Size, sess.Width, sess.Height, sess.DurationMs, body, &uploadKey)
	s.finishQuota(sess.UserID, sess.Day, sess.Size, resource, created, err, identity)
	if err == nil && resource != nil && resource.Status == model.ResourceStatusReady {
		s.quotaCommit(sess.UserID, sess.Size, identity)
	}
	return resource, err
}

func closeAssembled(file *os.File) {
	if file == nil {
		return
	}
	name := file.Name()
	_ = file.Close()
	_ = os.Remove(name)
}

func (s *Service) openSessionBody(sess *chunkedUploadSession) (*os.File, error) {
	if sess == nil || !sess.hasAllChunks() {
		return nil, UploadSessionIncomplete()
	}
	assembled, err := os.CreateTemp(sess.Dir, ".assembled-*")
	if err != nil {
		return nil, err
	}
	cleanup := func() {
		closeAssembled(assembled)
	}
	if err := assembled.Chmod(0o600); err != nil {
		cleanup()
		return nil, err
	}
	var copied int64
	for i := 0; i < sess.ChunkCount; i++ {
		chunk, err := os.Open(sess.chunkPath(i))
		if err != nil {
			cleanup()
			return nil, UploadSessionIncomplete()
		}
		expected := sess.chunkSizeAt(i)
		n, copyErr := io.Copy(assembled, &io.LimitedReader{R: chunk, N: expected})
		closeErr := chunk.Close()
		if copyErr != nil || closeErr != nil || n != expected {
			cleanup()
			return nil, UploadSessionIncomplete()
		}
		copied += n
	}
	if copied != sess.Size {
		cleanup()
		return nil, UploadSessionIncomplete()
	}
	if err := assembled.Sync(); err != nil {
		cleanup()
		return nil, err
	}
	if _, err := assembled.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, err
	}
	return assembled, nil
}

func (s *Service) readyResourceByIdentity(userID, identity string) (*model.Resource, error) {
	identity = strings.TrimSpace(identity)
	if identity == "" {
		return nil, nil
	}
	resource, err := s.resourceForUploadKey(userID, &identity)
	if err != nil || resource == nil {
		return resource, err
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	return nil, nil
}

func (s *Service) liveSessionByIdentityLocked(userID, identity string) *chunkedUploadSession {
	for _, sess := range s.sessions {
		if sess != nil && sess.UserID == userID && sess.Identity == identity {
			return sess
		}
	}
	return nil
}

func (s *Service) rememberCompletedLocked(userID, identity string, ready *model.Resource, req ChunkedUploadStart) *chunkedUploadSession {
	sessionID := newUploadSessionID()
	chunkCount := int((req.Size + ChunkUploadSize - 1) / ChunkUploadSize)
	if chunkCount < 1 {
		chunkCount = 1
	}
	sess := &chunkedUploadSession{
		ID: sessionID, UserID: userID, FileName: req.FileName, Kind: req.Kind,
		Size: req.Size, Width: req.Width, Height: req.Height, DurationMs: req.DurationMs,
		Identity: identity, ChunkCount: chunkCount, CreatedAt: time.Now(),
		complete: ready,
	}
	s.sessions[sessionID] = sess
	return sess
}

func (s *Service) createSessionDir(sessionID string) (string, error) {
	root := s.sessionRoot()
	if root == "" {
		return "", kernel.BadAuthRequest("上传会话无法创建")
	}
	dir := filepath.Join(root, sessionID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	return dir, nil
}

func writeSessionMeta(sess *chunkedUploadSession) error {
	if sess == nil || sess.Dir == "" {
		return nil
	}
	payload, err := json.Marshal(chunkSessionMeta{
		ID: sess.ID, UserID: sess.UserID, FileName: sess.FileName, Kind: sess.Kind,
		Size: sess.Size, Width: sess.Width, Height: sess.Height, DurationMs: sess.DurationMs,
		Identity: sess.Identity, Day: sess.Day, Reserved: sess.Reserved,
		ChunkCount: sess.ChunkCount, CreatedAt: sess.CreatedAt,
	})
	if err != nil {
		return err
	}
	return writeFileAtomic(sess.Dir, chunkSessionMetaName, payload)
}

func writeFileAtomic(dir, name string, payload []byte) error {
	if strings.TrimSpace(dir) == "" || strings.TrimSpace(name) == "" {
		return kernel.BadAuthRequest("上传会话无法创建")
	}
	temporary, err := os.CreateTemp(dir, "."+name+"-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := os.Rename(temporaryPath, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	return syncDirectory(dir)
}

func (s *Service) quotaRelease(userID, day string, size int64, identity string) {
	if s == nil || s.quota == nil {
		return
	}
	s.quota.Release(userID, day, size, identity)
}

func (s *Service) quotaCommit(userID string, size int64, identity string) {
	if s == nil || s.quota == nil {
		return
	}
	s.quota.Commit(userID, size, identity)
}

func (s *Service) dropSessionFilesLocked(sess *chunkedUploadSession) {
	if sess == nil || sess.Dir == "" {
		return
	}
	_ = os.RemoveAll(sess.Dir)
	sess.Dir = ""
}

func (s *Service) expireSessionsLocked(now time.Time) {
	for id, sess := range s.sessions {
		if sess == nil {
			delete(s.sessions, id)
			continue
		}
		if !sess.mu.TryLock() {
			continue
		}
		if now.Sub(sess.CreatedAt) <= chunkUploadTTL {
			sess.mu.Unlock()
			continue
		}
		if sess.complete != nil {
			s.dropSessionFilesLocked(sess)
			sess.mu.Unlock()
			delete(s.sessions, id)
			continue
		}
		err := s.releaseAbandonedSessionHeld(sess)
		sess.mu.Unlock()
		if err != nil {
			continue
		}
		delete(s.sessions, id)
	}
}

func (s *Service) releaseAbandonedSessionHeld(sess *chunkedUploadSession) error {
	if sess == nil {
		return nil
	}
	existing, err := s.resourceForUploadKey(sess.UserID, &sess.Identity)
	if err != nil {
		return err
	}
	if existing == nil && sess.Reserved {
		s.quotaRelease(sess.UserID, sess.Day, sess.Size, sess.Identity)
	}
	s.dropSessionFilesLocked(sess)
	return nil
}

func (s *Service) abandonStaleSessions() {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if err := s.abandonStaleSessionsLocked(); err != nil {
		log.Printf("upload reservation recovery failed: %v", err)
	}
}

func (s *Service) abandonStaleSessionsLocked() error {
	first := s.releaseOrphanReservationsLocked()
	if err := s.reconcileSessionDirsLocked(); err != nil && first == nil {
		first = err
	}
	return first
}

func (s *Service) releaseOrphanReservationsLocked() error {
	if s == nil || s.repo == nil {
		return nil
	}
	rows, err := s.repo.ListUploadReservations()
	if err != nil {
		return err
	}
	var first error
	for _, row := range rows {
		row := row
		if s.liveSessionByIdentityLocked(row.UserID, row.Identity) != nil {
			continue
		}
		existing, lookupErr := s.resourceForUploadKey(row.UserID, &row.Identity)
		if lookupErr != nil {
			if first == nil {
				first = lookupErr
			}
			continue
		}
		if settleErr := s.settleOrphanReservation(row, existing); settleErr != nil && first == nil {
			first = settleErr
		}
	}
	return first
}

func (s *Service) settleOrphanReservation(row model.UserUploadReservation, existing *model.Resource) error {
	if row.Unattributed() {
		return nil
	}
	if existing != nil && existing.Status == model.ResourceStatusPending {
		return nil
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return s.commitWitness(row.UserID, row.Identity, row.Size)
	}
	if existing != nil && existing.Status != model.ResourceStatusFailed {
		return s.commitWitness(row.UserID, row.Identity, row.Size)
	}
	return s.releaseWitness(row)
}

func (s *Service) commitWitness(userID, identity string, size int64) error {
	if s == nil || s.repo == nil {
		return nil
	}
	if err := s.repo.ClearUploadReservation(userID, identity); err != nil {
		return err
	}
	s.quotaCommit(userID, size, identity)
	return nil
}

func (s *Service) releaseWitness(row model.UserUploadReservation) error {
	if s == nil || s.repo == nil {
		return nil
	}
	if err := s.repo.ReleaseIdentifiedDailyUpload(row.UserID, row.Day, row.Identity, row.Size); err != nil {
		return err
	}
	s.quotaRelease(row.UserID, row.Day, row.Size, row.Identity)
	return nil
}

func (s *Service) reconcileSessionDirsLocked() error {
	root := s.sessionRoot()
	if root == "" {
		return nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var first error
	keep := func(err error) {
		if first == nil {
			first = err
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if s.sessions[entry.Name()] != nil {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		payload, readErr := os.ReadFile(filepath.Join(dir, chunkSessionMetaName))
		if readErr != nil {
			continue
		}
		var meta chunkSessionMeta
		if json.Unmarshal(payload, &meta) != nil || strings.TrimSpace(meta.UserID) == "" || strings.TrimSpace(meta.Identity) == "" {
			continue
		}
		existing, lookupErr := s.resourceForUploadKey(meta.UserID, &meta.Identity)
		if lookupErr != nil {
			keep(lookupErr)
			continue
		}
		if existing != nil {
			_ = os.RemoveAll(dir)
			continue
		}
		if !meta.Reserved {
			held, heldErr := s.reservationHeld(meta.UserID, meta.Identity)
			if heldErr != nil {
				keep(heldErr)
				continue
			}
			if !held {
				_ = os.RemoveAll(dir)
				continue
			}
		}
		s.quotaRelease(meta.UserID, meta.Day, meta.Size, meta.Identity)
		_ = os.RemoveAll(dir)
	}
	return first
}

func (s *Service) reservationHeld(userID, identity string) (bool, error) {
	row, err := s.lookupReservation(userID, identity)
	if err != nil {
		return false, err
	}
	return row != nil, nil
}

func (s *Service) lookupReservation(userID, identity string) (*model.UserUploadReservation, error) {
	if s == nil || s.repo == nil {
		return nil, nil
	}
	return s.repo.UploadReservation(userID, identity)
}
