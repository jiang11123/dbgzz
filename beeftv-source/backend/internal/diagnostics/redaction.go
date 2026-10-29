package diagnostics

import (
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func sanitizeClientEvent(event ClientEvent) clientEventRecord {
	return clientEventRecord{
		LaunchID: sanitizeIdentifier(event.LaunchID), SessionID: sanitizeIdentifier(event.SessionID), SpanID: sanitizeIdentifier(event.SpanID),
		ClientOperationID: sanitizeOperationID(event.ClientOperationID), NodeID: sanitizeIdentifier(event.NodeID),
		AssistantSessionID: sanitizeIdentifier(event.AssistantSessionID), AssistantTurnID: sanitizeIdentifier(event.AssistantTurnID), Media: sanitizeMedia(event.Media),
		CanvasBinding: sanitizeCanvasBinding(event.CanvasBinding),
		Reason:        sanitizeIdentifier(event.Reason),
		ID:            sanitizeIdentifier(event.ID), Timestamp: redactText(event.Timestamp, 80), Level: redactText(event.Level, 24), Category: redactText(event.Category, 32),
		Code: redactText(event.Code, 120), Message: redactText(event.Message, maxEventText), Route: sanitizePath(event.Route),
		DurationMs: boundedInt64(event.DurationMs, 0, 86_400_000), HTTPStatus: boundedInt(event.HTTPStatus, 0, 599),
		RequestID: sanitizeIdentifier(event.RequestID), TraceID: sanitizeIdentifier(event.TraceID), TaskID: sanitizeIdentifier(event.TaskID), ProjectID: sanitizeIdentifier(event.ProjectID), CanvasID: sanitizeIdentifier(event.CanvasID),
		Stack: redactText(event.Stack, maxEventText),
	}
}

func sanitizeTask(task model.Task) taskRecord {
	record := taskRecord{
		FailureDiagnostics: generation.SanitizeTaskDiagnostics(task.FailureDiagnostics),
		ID:                 task.ID, TraceID: sanitizeIdentifier(task.TraceID), RequestID: sanitizeIdentifier(task.RequestID), ProjectID: sanitizeIdentifier(task.ProjectID),
		Type: redactText(task.Type, 80), Status: redactText(string(task.Status), 32), Stage: redactText(task.Stage, 160), Progress: boundedInt(task.Progress, 0, 100),
		Operation: redactText(task.Operation, 120), Provider: redactText(task.Provider, 120), Model: redactText(task.Model, 160), LogicalModelID: sanitizeIdentifier(task.LogicalModelID),
		ProviderRequestID: sanitizeIdentifier(task.ProviderRequestID), Error: redactText(task.Error, maxEventText), Attempts: boundedInt(task.Attempts, 0, 100),
		StartedAt: task.StartedAt, CompletedAt: task.CompletedAt, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt,
	}
	if task.ClientOperationID != nil {
		record.ClientOperationID = sanitizeOperationID(*task.ClientOperationID)
	}
	record.OutputNodeIDs = taskNodeIDs(task)
	if len(record.OutputNodeIDs) == 1 {
		record.NodeID = record.OutputNodeIDs[0]
	}
	return record
}

func sanitizeTaskLog(taskLog model.TaskLog) taskLogRecord {
	return taskLogRecord{ID: taskLog.ID, TaskID: sanitizeIdentifier(taskLog.TaskID), TraceID: sanitizeIdentifier(taskLog.TraceID), RequestID: sanitizeIdentifier(taskLog.RequestID), Level: redactText(taskLog.Level, 24), Message: redactText(taskLog.Message, maxEventText), Payload: redactText(taskLog.Payload, maxEventText), CreatedAt: taskLog.CreatedAt}
}

func sanitizeAPICall(log model.ApiCallLog) apiCallRecord {
	return apiCallRecord{
		ID: log.ID, TraceID: sanitizeIdentifier(log.TraceID), RequestID: sanitizeIdentifier(log.RequestID), ChannelID: sanitizeIdentifier(log.ChannelID), TaskID: sanitizeIdentifier(log.TaskID),
		Source: redactText(log.Source, 80), Capability: redactText(log.Capability, 48), Operation: redactText(log.Operation, 120), RequestKind: redactText(log.RequestKind, 48), APIFormat: redactText(log.APIFormat, 48),
		Method: redactText(log.Method, 16), Path: sanitizePath(log.Path), Model: redactText(log.Model, 160), Status: redactText(string(log.Status), 32), StatusCode: boundedInt(log.StatusCode, 0, 599),
		DurationMs: boundedInt64(log.DurationMs, 0, 86_400_000), PollCount: boundedInt(log.PollCount, 0, 10000), ProviderStatus: redactText(log.ProviderStatus, 80),
		ProviderRequestID: sanitizeIdentifier(log.ProviderRequestID), ErrorCode: redactText(log.ErrorCode, 120), Error: redactText(log.Error, maxEventText), StartedAt: log.StartedAt, CreatedAt: log.CreatedAt,
	}
}

func sanitizeIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 96 {
		return ""
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("._:-", char) {
			continue
		}
		return ""
	}
	return value
}

func sanitizePath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if index := strings.IndexAny(value, "?#"); index >= 0 {
		value = value[:index]
	}
	return redactText(value, 300)
}

func redactText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	for _, marker := range []string{"authorization", "cookie", "set-cookie", "x-goog-api-key", "x-canvas-upstream-headers", "api_key", "api-key", "apikey", "access_key", "access-key", "secret_key", "secret-key", "password", "token="} {
		value = redactMarker(value, marker)
	}
	return kernel.TruncateRunes(redactURLs(value), limit)
}

func redactMarker(value string, marker string) string {
	searchFrom := 0
	for searchFrom < len(value) {
		lower := strings.ToLower(value)
		index := strings.Index(lower[searchFrom:], strings.ToLower(marker))
		if index < 0 {
			break
		}
		index += searchFrom
		end := index + len(marker)
		for end < len(value) && isSeparator(value[end]) {
			end++
		}
		valueEnd := end
		for valueEnd < len(value) && !isValueDelimiter(value[valueEnd]) {
			valueEnd++
		}
		if valueEnd == end {
			searchFrom = end
			continue
		}
		value = value[:end] + "[REDACTED]" + value[valueEnd:]
		searchFrom = end + len("[REDACTED]")
	}
	return value
}

func redactURLs(value string) string {
	searchFrom := 0
	for searchFrom < len(value) {
		startHTTP := strings.Index(value[searchFrom:], "http://")
		startHTTPS := strings.Index(value[searchFrom:], "https://")
		start := -1
		if startHTTP >= 0 {
			start = startHTTP
		}
		if startHTTPS >= 0 && (start < 0 || startHTTPS < start) {
			start = startHTTPS
		}
		if start < 0 {
			break
		}
		start += searchFrom
		end := start
		for end < len(value) && !isURLDelimiter(value[end]) {
			end++
		}
		raw := value[start:end]
		parsed, err := url.Parse(raw)
		if err != nil {
			searchFrom = end
			continue
		}
		parsed.RawQuery = ""
		parsed.Fragment = ""
		safe := parsed.String()
		value = value[:start] + safe + value[end:]
		searchFrom = start + len(safe)
	}
	return value
}

func isSeparator(value byte) bool {
	return value == ' ' || value == 9 || value == ':' || value == '='
}

func isValueDelimiter(value byte) bool {
	switch value {
	case ' ', 9, 13, 10, ',', ';', '"', 39, '<', '>', '}', ']':
		return true
	default:
		return false
	}
}

func isURLDelimiter(value byte) bool {
	return value == ' ' || value == 9 || value == 13 || value == 10 || value == '"' || value == 39 || value == '<' || value == '>'
}

func boundedInt(value int, min int, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func boundedInt64(value int64, min int64, max int64) int64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
