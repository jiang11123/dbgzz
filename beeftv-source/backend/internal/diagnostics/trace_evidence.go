package diagnostics

import "infinite-canvas/backend/internal/supporttrace"

func (s *Service) collectTraceEvidence(userID string, c *collection) {
	if s.traceSource == nil {
		c.unavailable("backendEvents", "collector_not_configured")
		return
	}
	snapshot, err := s.traceSource.Snapshot(userID, c.Window.From, c.Window.To)
	// A reader can return valid records before encountering a damaged segment.
	// Keep that evidence, while authentication failures still fail the export.
	c.recordAuthError(err)
	traceCoverage := snapshot.Coverage
	switch traceCoverage.Status {
	case "complete", "partial", "unavailable", "failed", "truncated":
	default:
		traceCoverage.Status = "partial"
	}
	traceCoverage.Records, traceCoverage.Dropped, traceCoverage.WriteErrors, traceCoverage.Bytes = max(traceCoverage.Records, 0), max(traceCoverage.Dropped, 0), max(traceCoverage.WriteErrors, 0), max(traceCoverage.Bytes, 0)
	traceCoverage.RetentionHours, traceCoverage.MaxBytes = max(traceCoverage.RetentionHours, 0), max(traceCoverage.MaxBytes, 0)
	c.TraceCoverage = &traceCoverage
	for _, event := range snapshot.Events {
		if event.UserID != userID || event.Timestamp.Before(c.Window.From) || event.Timestamp.After(c.Window.To) {
			continue
		}
		if c.TaskID != "" && event.TaskID != c.TaskID {
			continue
		}
		if c.TaskID == "" && c.ProjectID != "" && event.CanvasID != c.ProjectID {
			continue
		}
		c.BackendEvents = append(c.BackendEvents, supporttrace.Event{
			Fields: supporttrace.Fields{RequestID: sanitizeIdentifier(event.RequestID), TaskID: sanitizeIdentifier(event.TaskID), CanvasID: sanitizeIdentifier(event.CanvasID), NodeID: sanitizeIdentifier(event.NodeID), SessionID: sanitizeIdentifier(event.SessionID), TurnID: sanitizeIdentifier(event.TurnID), OperationID: sanitizeOperationID(event.OperationID), Reason: sanitizeIdentifier(event.Reason)},
			ID:     sanitizeIdentifier(event.ID), Timestamp: event.Timestamp, Name: sanitizeIdentifier(event.Name), Phase: sanitizeIdentifier(event.Phase), LaunchID: sanitizeIdentifier(event.LaunchID),
			TraceID: sanitizeIdentifier(event.TraceID), SpanID: sanitizeIdentifier(event.SpanID), ParentSpanID: sanitizeIdentifier(event.ParentSpanID), DurationMs: boundedInt64(event.DurationMs, 0, 86400000), Status: sanitizeIdentifier(event.Status),
		})
	}
	c.setCoverage("backendEvents", len(c.BackendEvents), 5000, nil)
	if len(c.BackendEvents) > 5000 {
		c.BackendEvents = c.BackendEvents[:5000]
	}
	coverage := c.Collectors["backendEvents"]
	coverage.Scope = "recorder_retained_history"
	coverage.From, coverage.To = snapshot.Coverage.From, snapshot.Coverage.To
	if snapshot.Coverage.Status != "complete" && coverage.Status != "truncated" {
		coverage.Status, coverage.Reason = "partial", "recorder_history_partial"
	}
	if snapshot.Coverage.Status == "failed" || snapshot.Coverage.Status == "unavailable" {
		coverage.Status = snapshot.Coverage.Status
	}
	if err != nil {
		coverage.Status, coverage.Reason = "failed", "recorder_read_failed"
		traceCoverage.Status = "failed"
		if len(c.BackendEvents) > 0 {
			coverage.Status, coverage.Reason = "partial", "recorder_read_partial"
			traceCoverage.Status = "partial"
		}
	}
	if snapshot.Coverage.Dropped > 0 {
		coverage.Status, coverage.Reason = "truncated", "recorder_retention"
		coverage.OmittedAtLeast += snapshot.Coverage.Dropped
		c.Truncated = true
	}
	if snapshot.Coverage.Status == "truncated" {
		coverage.Status, coverage.Reason = "truncated", "recorder_history_limit"
		c.Truncated = true
	}
	if snapshot.Coverage.WriteErrors > 0 {
		if coverage.Status != "truncated" && coverage.Status != "failed" {
			coverage.Status, coverage.Reason = "partial", "recorder_write_errors"
		}
	}
	if err != nil && len(c.BackendEvents) == 0 {
		coverage.Status, coverage.Reason = "failed", "recorder_read_failed"
	}
	c.Collectors["backendEvents"] = coverage
}
