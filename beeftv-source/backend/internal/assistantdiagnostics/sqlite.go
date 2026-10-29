package assistantdiagnostics

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"infinite-canvas/backend/internal/diagnostics"
)

func readSession(file string, session ownedSession, from, to time.Time, out *diagnostics.AssistantEvidenceSnapshot) error {
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("runtime_file_unavailable")
	}
	// Refuse links before passing a generated path to SQLite; only fixed table
	// metadata columns below are ever selected, never transcript/content fields.
	resolved, err := filepath.EvalSymlinks(file)
	if err != nil {
		return errors.New("runtime_file_unavailable")
	}
	abs, err := filepath.Abs(file)
	if err != nil || resolved != abs {
		return errors.New("runtime_file_linked")
	}
	uriPath := filepath.ToSlash(file)
	if filepath.VolumeName(file) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := url.URL{Scheme: "file", Path: uriPath}
	q := u.Query()
	q.Set("mode", "ro")
	q.Set("_query_only", "1")
	q.Set("_busy_timeout", "250")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite3", u.String())
	if err != nil {
		return errors.New("runtime_database_unavailable")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	var schema int
	if db.QueryRowContext(ctx, "SELECT version FROM durable_schema WHERE singleton = 1").Scan(&schema) != nil || schema != 1 {
		return errors.New("runtime_schema_unsupported")
	}
	reasonCodes := diagnostics.AssistantFailureReasonCodes()
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(reasonCodes)), ",")
	args := make([]any, 0, len(reasonCodes)+2)
	for _, code := range reasonCodes {
		args = append(args, code)
	}
	args = append(args, from.UnixMilli(), to.UnixMilli())
	// Compare exact known codes inside SQLite. Raw errorMessage/content values
	// never cross the query boundary, even when they contain private text.
	rows, err := db.QueryContext(ctx, `SELECT e.id, m.key,
 COALESCE(json_extract(m.value,'$.role'),''), COALESCE(json_extract(m.value,'$.timestamp'),0),
 COALESCE(json_extract(m.value,'$.model'),''), COALESCE(json_extract(m.value,'$.stopReason'),''),
 COALESCE(json_extract(m.value,'$.durationMs'),0), COALESCE(json_extract(m.value,'$.toolName'),''),
 COALESCE(json_extract(m.value,'$.toolCallId'),''), COALESCE(json_extract(m.value,'$.isError'),0),
 CASE WHEN (json_extract(m.value,'$.stopReason') = 'error' OR
 (json_extract(m.value,'$.role') = 'toolResult' AND json_extract(m.value,'$.isError') = 1))
 AND json_extract(m.value,'$.errorMessage') IN (`+placeholders+`) THEN json_extract(m.value,'$.errorMessage') ELSE '' END
 FROM entries e, json_each(e.record,'$.model') m
 WHERE json_extract(m.value,'$.role') IN ('assistant','toolResult')
 AND json_extract(m.value,'$.timestamp') BETWEEN ? AND ?
 ORDER BY e.commit_seq, m.key LIMIT 2001`, args...)
	if err != nil {
		return errors.New("runtime_metadata_unavailable")
	}
	for rows.Next() {
		var id, index, stamp, duration int64
		var role, model, stop, tool, toolID, failureReason string
		var isError bool
		if rows.Scan(&id, &index, &role, &stamp, &model, &stop, &duration, &tool, &toolID, &isError, &failureReason) != nil {
			rows.Close()
			return errors.New("runtime_metadata_invalid")
		}
		record := diagnostics.AssistantRuntimeEvidence{ID: fmt.Sprintf("durable:%s:entry:%d:%d", strings.TrimPrefix(session.sessionID, "durable:"), id, index), SessionID: session.sessionID, CanvasID: session.canvasID, Kind: "model_call", Name: "model.response", Status: stop, Reason: "turn_link_not_recorded", FailureReason: failureReason, Model: model, Timestamp: time.UnixMilli(stamp).UTC(), DurationMs: duration}
		if role == "toolResult" {
			record.Kind = "tool"
			record.Name = tool
			record.OperationID = toolID
			record.Status = "completed"
			if isError {
				record.Status = "failed"
			}
		}
		out.Records = append(out.Records, record)
		if len(out.Records) > maxRecords {
			out.Coverage.Status = "truncated"
			break
		}
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return errors.New("runtime_metadata_unavailable")
	}
	// Persisted responses do not prove every submitted call produced a response,
	// and old entries lack an exact business-turn link. Keep that gap explicit.
	if out.Coverage.Status == "complete" {
		out.Coverage.Status = "partial"
	}
	return nil
}
