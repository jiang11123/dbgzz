// Package assistantdiagnostics reads metadata from existing official-runtime
// history. It never opens a Harness, resumes a task or returns transcript text.
package assistantdiagnostics

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/diagnostics"
)

const maxRecords = 2000

var sessionPattern = regexp.MustCompile(`^durable:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$`)

type Reader struct{ dataDir string }

func New(dataDir string) *Reader {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return &Reader{dataDir: dataDir}
	}
	if resolved, resolveErr := filepath.EvalSymlinks(abs); resolveErr == nil {
		abs = resolved
	}
	return &Reader{dataDir: abs}
}

type ownedSession struct{ sessionID, canvasID string }

func (r *Reader) DiagnosticAssistantEvidence(userID string, from, to time.Time, turns []diagnostics.AssistantTurnEvidence) (diagnostics.AssistantEvidenceSnapshot, error) {
	out := diagnostics.AssistantEvidenceSnapshot{Coverage: diagnostics.CollectorCoverage{Status: "complete", Scope: "window", Limit: maxRecords, From: &from, To: &to}}
	if userID == "" {
		return out, errors.New("assistant_scope_required")
	}
	root, err := os.OpenRoot(r.dataDir)
	if err != nil {
		out.Coverage.Status = "unavailable"
		out.Coverage.Reason = "assistant_directory_unavailable"
		return out, nil
	}
	defer root.Close()
	deadline := time.Now().Add(3 * time.Second)
	allowed := make(map[string]diagnostics.AssistantTurnEvidence, len(turns))
	sessions := map[string]ownedSession{}
	for _, t := range turns {
		if sessionPattern.MatchString(t.SessionID) && t.CanvasID != "" {
			allowed[t.ID] = t
			sessions[t.SessionID] = ownedSession{t.SessionID, t.CanvasID}
		}
	}
	// Old ledgers lack turn/session linkage. Never guess ownership from time.
	for part := 0; part < 4; part++ {
		name := "agent-requests.jsonl"
		if part > 0 {
			name += fmt.Sprintf(".%d", part)
		}
		f, openErr := root.Open(name)
		if os.IsNotExist(openErr) {
			continue
		}
		if openErr != nil {
			out.Coverage.Status = "partial"
			continue
		}
		if readErr := readLedger(io.LimitReader(f, 1<<20), allowed, from, to, &out); readErr != nil {
			out.Coverage.Status = "partial"
		}
		if info, statErr := f.Stat(); statErr != nil || info.Size() > 1<<20 {
			out.Coverage.Status = "partial"
		}
		f.Close()
	}
	keys := make([]string, 0, len(sessions))
	for k := range sessions {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for index, key := range keys {
		if time.Now().After(deadline) {
			out.Coverage.Status = "partial"
			out.Coverage.OmittedAtLeast++
			break
		}
		if index >= 32 || len(out.Records) >= maxRecords {
			out.Coverage.Status = "truncated"
			out.Coverage.OmittedAtLeast++
			break
		}
		session := sessions[key]
		hash := sha256.Sum256([]byte(session.canvasID))
		directory := filepath.Join("sessions", hex.EncodeToString(hash[:])[:24], "durable")
		base := strings.TrimPrefix(session.sessionID, "durable:")
		manifest, readErr := root.Open(filepath.Join(directory, base+".json"))
		if readErr != nil {
			out.Coverage.Status = "partial"
			continue
		}
		var pin struct {
			CanvasID  string `json:"canvasId"`
			SessionID string `json:"sessionId"`
			Version   string `json:"version"`
		}
		readErr = json.NewDecoder(io.LimitReader(manifest, 64<<10)).Decode(&pin)
		manifest.Close()
		if readErr != nil || pin.CanvasID != session.canvasID || pin.SessionID != session.sessionID || pin.Version != "1.0.4" {
			out.Coverage.Status = "partial"
			continue
		}
		// This projection is deliberately pinned to Durable schema 1. Unsupported
		// formats are reported as missing evidence, never opened for execution.
		file := filepath.Join(r.dataDir, directory, base+".sqlite")
		if readErr := readSession(file, session, from, to, &out); readErr != nil {
			out.Coverage.Status = "partial"
			out.Coverage.Reason = readErr.Error() // readSession returns fixed reason codes only.
		}
	}
	if len(out.Records) > maxRecords {
		out.Coverage.OmittedAtLeast += int64(len(out.Records) - maxRecords)
		out.Records = out.Records[:maxRecords]
		out.Coverage.Status = "truncated"
	}
	sort.SliceStable(out.Records, func(i, j int) bool { return out.Records[i].Timestamp.Before(out.Records[j].Timestamp) })
	out.Coverage.Records = len(out.Records)
	if len(keys) == 0 && out.Coverage.Status == "complete" {
		out.Coverage.Status = "unavailable"
		out.Coverage.Reason = "no_owned_durable_sessions"
	} else if out.Coverage.Status == "partial" && out.Coverage.Reason == "" {
		out.Coverage.Reason = "runtime_history_partial"
	} else if out.Coverage.Status == "truncated" && out.Coverage.Reason == "" {
		out.Coverage.Reason = "runtime_history_limit"
	}
	return out, nil
}

func readLedger(reader io.Reader, allowed map[string]diagnostics.AssistantTurnEvidence, from, to time.Time, out *diagnostics.AssistantEvidenceSnapshot) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 8192)
	for scanner.Scan() {
		var row struct{ ID, At, TurnID, CanvasID, SessionID, RequestID, Model string }
		if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
			return errors.New("dispatch_record_invalid")
		}
		stamp, err := time.Parse(time.RFC3339Nano, row.At)
		if err != nil {
			out.Coverage.Status = "partial"
			continue
		}
		if stamp.Before(from) || stamp.After(to) {
			continue
		}
		turn, ok := allowed[row.TurnID]
		if !ok || row.SessionID != turn.SessionID || row.CanvasID != turn.CanvasID || row.ID == "" {
			// No ownership claim can be made for legacy or unmatched dispatches.
			out.Coverage.Status = "partial"
			continue
		}
		out.Records = append(out.Records, diagnostics.AssistantRuntimeEvidence{ID: "dispatch:" + row.ID, SessionID: turn.SessionID, TurnID: turn.ID, CanvasID: turn.CanvasID, Kind: "model_call", Name: "model.dispatch", Status: "dispatched", RequestID: row.RequestID, Model: row.Model, Timestamp: stamp})
		if len(out.Records) > maxRecords {
			out.Coverage.Status = "truncated"
			return nil
		}
	}
	return scanner.Err()
}
