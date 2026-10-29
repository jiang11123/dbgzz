package diagnostics

import "slices"

func (s *Service) collectAssistantEvidence(userID string, c *collection) {
	store, ok := s.store.(assistantTurnStore)
	if !ok {
		c.unavailable("assistantTurns", "collector_not_supported")
		c.unavailable("assistantRuntime", "business_turns_unavailable")
		return
	}
	turns, err := store.DiagnosticAssistantTurns(userID, c.Window.From, c.Window.To, c.ProjectID, c.TaskID)
	c.setCoverage("assistantTurns", len(turns), 100, err)
	if err != nil {
		c.unavailable("assistantRuntime", "business_turns_unavailable")
		return
	}
	if len(turns) > 100 {
		turns = turns[:100]
	}
	slices.Reverse(turns)
	for _, turn := range turns {
		c.AssistantTurns = append(c.AssistantTurns, AssistantTurnEvidence{
			ID: sanitizeIdentifier(turn.TurnID), SessionID: sanitizeIdentifier(turn.DurableSessionID), CanvasID: sanitizeIdentifier(turn.CanvasID),
			State: sanitizeIdentifier(turn.State), RevisionBefore: max(turn.RevisionBefore, 0), CreatedAt: turn.CreatedAt, UpdatedAt: turn.UpdatedAt,
			Undone: turn.Undone, ContinuationInvalidated: turn.ContinuationInvalidated,
		})
	}
	if s.assistantEvidence == nil {
		c.unavailable("assistantRuntime", "collector_not_configured")
		return
	}
	snapshot, err := s.assistantEvidence.DiagnosticAssistantEvidence(userID, c.Window.From, c.Window.To, c.AssistantTurns)
	if err != nil {
		c.setCoverage("assistantRuntime", 0, 0, err)
		return
	}
	allowed := map[string]AssistantTurnEvidence{}
	sessions := map[string]AssistantTurnEvidence{}
	for _, turn := range c.AssistantTurns {
		allowed[turn.ID] = turn
	}
	for _, turn := range c.AssistantTurns {
		if turn.SessionID != "" {
			sessions[turn.SessionID+"|"+turn.CanvasID] = turn
		}
	}
	rejected := 0
	for _, record := range snapshot.Records {
		turn, ok := allowed[record.TurnID]
		if record.TurnID == "" && record.Reason == "turn_link_not_recorded" {
			turn, ok = sessions[record.SessionID+"|"+record.CanvasID]
			turn.ID = ""
		}
		if !ok || record.SessionID != turn.SessionID || record.CanvasID != turn.CanvasID || record.Timestamp.Before(c.Window.From) || record.Timestamp.After(c.Window.To) {
			rejected++
			continue
		}
		switch record.Kind {
		case "model_call", "tool", "recovery":
		default:
			rejected++
			continue
		}
		c.AssistantEvidence = append(c.AssistantEvidence, AssistantRuntimeEvidence{
			ID: sanitizeIdentifier(record.ID), SessionID: turn.SessionID, TurnID: turn.ID, CanvasID: turn.CanvasID, Kind: record.Kind,
			Name: sanitizeIdentifier(record.Name), Status: sanitizeIdentifier(record.Status), Reason: sanitizeIdentifier(record.Reason), FailureReason: sanitizeAssistantFailureReason(record.FailureReason), OperationID: sanitizeOperationID(record.OperationID),
			RequestID: sanitizeIdentifier(record.RequestID), Model: redactText(record.Model, 160), Timestamp: record.Timestamp, DurationMs: boundedInt64(record.DurationMs, 0, 86400000),
		})
	}
	c.setCoverage("assistantRuntime", len(c.AssistantEvidence), 2000, nil)
	coverage := c.Collectors["assistantRuntime"]
	if len(c.AssistantEvidence) > 2000 {
		c.AssistantEvidence = c.AssistantEvidence[:2000]
	}
	if snapshot.Coverage.Status != "complete" && coverage.Status != "truncated" {
		coverage.Status, coverage.Reason = "partial", sanitizeIdentifier(snapshot.Coverage.Reason)
		switch snapshot.Coverage.Status {
		case "unavailable", "failed":
			coverage.Status = snapshot.Coverage.Status
		}
		if coverage.Reason == "" {
			switch coverage.Status {
			case "unavailable":
				coverage.Reason = "runtime_history_unavailable"
			case "failed":
				coverage.Reason = "runtime_history_failed"
			default:
				coverage.Reason = "runtime_history_partial"
			}
		}
	}
	coverage.OmittedAtLeast += max(snapshot.Coverage.OmittedAtLeast, 0)
	if rejected > 0 {
		if coverage.Status != "truncated" {
			coverage.Status, coverage.Reason = "partial", "unscoped_records_rejected"
		}
		coverage.OmittedAtLeast += int64(rejected)
	}
	if snapshot.Coverage.Status == "truncated" {
		coverage.Status, coverage.Reason = "truncated", sanitizeIdentifier(snapshot.Coverage.Reason)
		if coverage.Reason == "" {
			coverage.Reason = "runtime_history_limit"
		}
		c.Truncated = true
	}
	c.Collectors["assistantRuntime"] = coverage
}
