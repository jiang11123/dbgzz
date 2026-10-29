package supporttrace

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const (
	defaultMaxBytes  = 8 << 20
	defaultRetention = 48 * time.Hour
	maxLineBytes     = 4096
	maxOwners        = 128
	maxCoverageBytes = 64 << 10
)

type ownerCoverage struct {
	UserID      string     `json:"userId"`
	Dropped     int64      `json:"dropped"`
	WriteErrors int64      `json:"writeErrors"`
	DroppedFrom *time.Time `json:"droppedFrom,omitempty"`
	DroppedTo   *time.Time `json:"droppedTo,omitempty"`
	ErrorsFrom  *time.Time `json:"errorsFrom,omitempty"`
	ErrorsTo    *time.Time `json:"errorsTo,omitempty"`
}

type journalState struct {
	Owners     []ownerCoverage `json:"owners"`
	Incomplete bool            `json:"incomplete,omitempty"`
}

// journal is protected by Recorder.mu. Counters and their time bounds are
// owner-scoped and persisted before removing records. Incomplete is sticky
// when corruption prevents assigning lost evidence to a known owner/window.
type journal struct {
	path             string
	statePath        string
	state            journalState
	maxBytes         int64
	retention        time.Duration
	size             int64
	oldest           time.Time
	now              func() time.Time
	stateDirty       bool
	lastStateAttempt time.Time
}

func openJournal(dataDir string) (*journal, error) {
	if dataDir == "" {
		return nil, errors.New("support trace data directory is required")
	}
	dir := filepath.Join(dataDir, "support-traces")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create support trace directory: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return nil, errors.New("support trace directory must be a directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, fmt.Errorf("secure support trace directory: %w", err)
	}
	j := &journal{path: filepath.Join(dir, "events.jsonl"), statePath: filepath.Join(dir, "coverage.json"), maxBytes: defaultMaxBytes, retention: defaultRetention, now: time.Now}
	if data, err := readBounded(j.statePath, maxCoverageBytes); err == nil {
		if json.Unmarshal(data, &j.state) != nil || len(j.state.Owners) > maxOwners {
			j.state = journalState{Incomplete: true}
		}
		for _, owner := range j.state.Owners {
			if owner.UserID == "" || safeValue(owner.UserID, false) != owner.UserID || owner.Dropped < 0 || owner.WriteErrors < 0 || reversedRange(owner.DroppedFrom, owner.DroppedTo) || reversedRange(owner.ErrorsFrom, owner.ErrorsTo) {
				j.state = journalState{Incomplete: true}
				break
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		j.state.Incomplete = true
	}
	for _, path := range []string{j.path + ".tmp", j.statePath + ".tmp"} {
		if _, err := regularFile(path); err == nil {
			j.state.Incomplete = true
			_ = os.Remove(path)
		} else if !errors.Is(err, os.ErrNotExist) {
			j.state.Incomplete = true
		}
	}
	if j.state.Incomplete {
		_ = j.saveState()
	}
	// Errors here degrade coverage. The caller can still run business work and
	// export any valid prefix instead of failing application startup.
	_, _ = j.compact(false)
	return j, nil
}

func (j *journal) owner(userID string) *ownerCoverage {
	for i := range j.state.Owners {
		if j.state.Owners[i].UserID == userID {
			return &j.state.Owners[i]
		}
	}
	if len(j.state.Owners) == maxOwners {
		// A desktop normally has one owner. Bound hostile/accidental owner
		// cardinality and explicitly retain the fact that coverage was lost.
		j.state.Incomplete = true
		copy(j.state.Owners, j.state.Owners[1:])
		j.state.Owners = j.state.Owners[:maxOwners-1]
	}
	j.state.Owners = append(j.state.Owners, ownerCoverage{UserID: userID})
	return &j.state.Owners[len(j.state.Owners)-1]
}

func (j *journal) saveState() error {
	j.stateDirty = true
	j.lastStateAttempt = j.now()
	data, err := json.Marshal(j.state)
	if err != nil {
		return err
	}
	err = writeAtomic(j.statePath, append(data, '\n'))
	if err == nil {
		j.stateDirty = false
	}
	return err
}

func (j *journal) drop(userID string, count int64) {
	j.recordDrop(userID, j.now(), count)
	if err := j.saveState(); err != nil {
		owner := j.owner(userID)
		owner.WriteErrors++
		extendRange(&owner.ErrorsFrom, &owner.ErrorsTo, j.now())
		j.state.Incomplete = true
	}
}

func (j *journal) recordDrop(userID string, at time.Time, count int64) {
	owner := j.owner(userID)
	owner.Dropped += count
	extendRange(&owner.DroppedFrom, &owner.DroppedTo, at)
}

func (j *journal) failedWrite(userID string) {
	owner := j.owner(userID)
	owner.WriteErrors++
	extendRange(&owner.ErrorsFrom, &owner.ErrorsTo, j.now())
	// If the disk is unavailable this counter remains in memory and is retried
	// with the next successful operation; it cannot be made durable on that disk.
	_ = j.saveState()
}

func (j *journal) append(event Event, durable bool) {
	data, err := json.Marshal(event)
	if err != nil || len(data)+1 > maxLineBytes {
		j.drop(event.UserID, 1)
		return
	}
	data = append(data, '\n')
	info, statErr := regularFile(j.path)
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		j.failedWrite(event.UserID)
		return
	}
	if info != nil {
		j.size = info.Size()
	} else if j.size != 0 {
		j.state.Incomplete = true
		j.size = 0
		_ = j.saveState()
	}
	if j.size+int64(len(data)) > j.maxBytes || (!j.oldest.IsZero() && j.oldest.Before(j.now().Add(-j.retention))) {
		if _, err := j.compact(j.size+int64(len(data)) > j.maxBytes); err != nil {
			j.failedWrite(event.UserID)
			return
		}
	}
	if int64(len(data)) > j.maxBytes {
		j.drop(event.UserID, 1)
		return
	}
	file, err := os.OpenFile(j.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		j.failedWrite(event.UserID)
		return
	}
	err = file.Chmod(0600)
	if err == nil {
		var n int
		n, err = file.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err == nil && durable {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		j.failedWrite(event.UserID)
		return
	}
	j.size += int64(len(data))
	if j.oldest.IsZero() {
		j.oldest = event.Timestamp
	}
	// Retry a failed coverage write after storage becomes writable again.
	if j.stateDirty && j.now().Sub(j.lastStateAttempt) >= time.Second {
		_ = j.saveState()
	}
}

func (j *journal) readEvents() ([]Event, int64, error) {
	info, err := regularFile(j.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	j.size = info.Size()
	file, err := os.Open(j.path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	var last [1]byte
	unterminated := info.Size() > 0
	if info.Size() > 0 {
		if _, err := file.ReadAt(last[:], info.Size()-1); err != nil {
			return nil, 0, err
		}
		unterminated = last[0] != '\n'
	}
	scanner := bufio.NewScanner(io.LimitReader(file, j.maxBytes+1))
	scanner.Buffer(make([]byte, maxLineBytes), maxLineBytes)
	var events []Event
	var corrupt int64
	var offset int64
	for scanner.Scan() {
		offset += int64(len(scanner.Bytes()) + 1)
		var event Event
		if (unterminated && offset >= info.Size()) || json.Unmarshal(scanner.Bytes(), &event) != nil || !validEvent(event) {
			corrupt++
			continue
		}
		events = append(events, event)
	}
	if scanner.Err() != nil || info.Size() > j.maxBytes {
		// Keep the valid prefix and repair an oversized/malformed tail before
		// appending. Mark the unassignable missing portion explicitly.
		corrupt++
	}
	return events, corrupt, nil
}

func validEvent(event Event) bool {
	if event.UserID == "" || cleanFields(event.Fields) != event.Fields || event.Timestamp.IsZero() || safeValue(event.Name, true) == "" || safeValue(event.ID, false) == "" || safeValue(event.LaunchID, false) == "" {
		return false
	}
	if event.Phase != "start" && event.Phase != "end" && event.Phase != "event" {
		return false
	}
	return (event.TraceID == "" || hexID(event.TraceID, 32)) && (event.SpanID == "" || hexID(event.SpanID, 16)) && (event.ParentSpanID == "" || hexID(event.ParentSpanID, 16)) && (event.Status == "" || event.Status == "ok" || event.Status == "error")
}

func hexID(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// compact discards expired records, and the oldest quarter when full. The
// persisted counters precede the atomic journal replacement, so a kill during
// compaction can over-report loss but cannot silently erase the loss marker.
func (j *journal) compact(full bool) ([]Event, error) {
	events, corrupt, readErr := j.readEvents()
	if corrupt != 0 || readErr != nil {
		j.state.Incomplete = true
		_ = j.saveState()
	}
	if readErr != nil {
		return events, readErr
	}
	cutoff := j.now().Add(-j.retention)
	kept := make([]Event, 0, len(events))
	var encoded [][]byte
	var size int64
	for _, event := range events {
		if event.Timestamp.Before(cutoff) {
			j.recordDrop(event.UserID, event.Timestamp, 1)
			continue
		}
		data, _ := json.Marshal(event)
		data = append(data, '\n')
		kept = append(kept, event)
		encoded = append(encoded, data)
		size += int64(len(data))
	}
	if full {
		for size > j.maxBytes*3/4 && len(kept) > 0 {
			j.recordDrop(kept[0].UserID, kept[0].Timestamp, 1)
			size -= int64(len(encoded[0]))
			kept, encoded = kept[1:], encoded[1:]
		}
	}
	j.oldest = time.Time{}
	for _, event := range kept {
		if j.oldest.IsZero() || event.Timestamp.Before(j.oldest) {
			j.oldest = event.Timestamp
		}
	}
	if len(kept) == len(events) && corrupt == 0 {
		return kept, nil
	}
	if err := j.saveState(); err != nil {
		j.state.Incomplete = true
		return events, err
	}
	data := make([]byte, 0, size)
	for _, line := range encoded {
		data = append(data, line...)
	}
	if err := writeAtomic(j.path, data); err != nil {
		j.state.Incomplete = true
		return events, err
	}
	j.size = size
	return kept, nil
}

func (j *journal) snapshot(userID string, from, to time.Time) (Snapshot, error) {
	events, err := j.compact(false)
	if from.IsZero() {
		from = j.now().Add(-j.retention)
	}
	if to.IsZero() {
		to = j.now()
		// SDK span ends use monotonic elapsed time. On Windows their wall
		// timestamps can briefly lead time.Now(), despite already being durable.
		// An unbounded snapshot includes all retained records for this owner;
		// explicit caller-supplied time windows remain strict.
		for _, event := range events {
			if event.UserID == userID && event.Timestamp.After(to) {
				to = event.Timestamp
			}
		}
	}
	result := Snapshot{Events: []Event{}, Coverage: Coverage{Status: "complete", RetentionHours: int(j.retention.Hours()), MaxBytes: j.maxBytes}}
	for _, event := range events {
		if event.UserID != userID || event.Timestamp.Before(j.now().Add(-j.retention)) || (!from.IsZero() && event.Timestamp.Before(from)) || (!to.IsZero() && event.Timestamp.After(to)) {
			continue
		}
		result.Events = append(result.Events, event)
		data, _ := json.Marshal(event)
		result.Coverage.Bytes += int64(len(data) + 1)
		timestamp := event.Timestamp
		if result.Coverage.From == nil || timestamp.Before(*result.Coverage.From) {
			result.Coverage.From = &timestamp
		}
		if result.Coverage.To == nil || timestamp.After(*result.Coverage.To) {
			result.Coverage.To = &timestamp
		}
	}
	for _, owner := range j.state.Owners {
		if owner.UserID == userID {
			if rangeIntersects(owner.DroppedFrom, owner.DroppedTo, from, to) {
				result.Coverage.Dropped = owner.Dropped
			}
			if rangeIntersects(owner.ErrorsFrom, owner.ErrorsTo, from, to) {
				result.Coverage.WriteErrors = owner.WriteErrors
			}
		}
	}
	result.Coverage.Records = len(result.Events)
	if err != nil || j.state.Incomplete || result.Coverage.Dropped != 0 || result.Coverage.WriteErrors != 0 {
		result.Coverage.Status = "partial"
	}
	if err != nil {
		return result, errors.New("support trace journal unavailable")
	}
	return result, nil
}

func extendRange(from, to **time.Time, at time.Time) {
	at = at.UTC()
	if *from == nil || at.Before(**from) {
		*from = &at
	}
	if *to == nil || at.After(**to) {
		*to = &at
	}
}

func rangeIntersects(first, last *time.Time, from, to time.Time) bool {
	// Unknown bounds are conservatively included. Counts can cover a wider
	// range than the requested window; they are never presented as exact loss.
	return first == nil || last == nil || !first.After(to) && !last.Before(from)
}

func reversedRange(first, last *time.Time) bool {
	return first != nil && last != nil && first.After(*last)
}

func (j *journal) sync() error {
	if err := j.saveState(); err != nil {
		return err
	}
	if _, err := regularFile(j.path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	file, err := os.OpenFile(j.path, os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}

func regularFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("support trace file is not regular")
	}
	return info, err
}

func readBounded(path string, limit int64) ([]byte, error) {
	info, err := regularFile(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > limit {
		return nil, errors.New("support trace metadata exceeded byte limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if int64(len(data)) > limit {
		return nil, errors.New("support trace metadata exceeded byte limit")
	}
	return data, err
}

func writeAtomic(path string, data []byte) error {
	if _, err := regularFile(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temp := path + ".tmp"
	if _, err := regularFile(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	err = file.Chmod(0600)
	if err == nil {
		var n int
		n, err = file.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	return os.Rename(temp, path)
}
