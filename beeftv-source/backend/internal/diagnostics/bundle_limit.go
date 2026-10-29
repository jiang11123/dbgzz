package diagnostics

import "infinite-canvas/backend/internal/kernel"

func buildBoundedZIP(brand, id string, manifest manifest, c *collection, limit int) ([]byte, error) {
	for {
		if c.ClientCoverage != nil {
			c.ClientCoverage.ExportedCount = len(c.ClientEvents)
		}
		manifest.Counts, manifest.Collectors, manifest.Truncated = c.counts(), c.Collectors, c.Truncated
		c.Findings = analyze(c)
		data, err := buildZIP(brand, id, manifest, c)
		if err != nil {
			return nil, err
		}
		if len(data) <= limit {
			return data, nil
		}
		// Keep business summaries longest. Trim bulk evidence in batches, then
		// recompute findings so every reference still resolves in the final ZIP.
		name, removed := "", 0
		switch {
		case len(c.TaskLogs) > 0:
			removed = trimCount(len(c.TaskLogs))
			c.TaskLogs = c.TaskLogs[removed:]
			name = "taskLogs"
		case len(c.ClientEvents) > 0:
			removed = trimCount(len(c.ClientEvents))
			c.ClientEvents = c.ClientEvents[removed:]
			name = "clientEvents"
		case len(c.BackendEvents) > 0:
			removed = trimCount(len(c.BackendEvents))
			c.BackendEvents = c.BackendEvents[removed:]
			name = "backendEvents"
		case len(c.APICalls) > 0:
			removed = trimCount(len(c.APICalls))
			c.APICalls = c.APICalls[removed:]
			name = "upstreamCalls"
		case len(c.AssistantEvidence) > 0:
			removed = trimCount(len(c.AssistantEvidence))
			c.AssistantEvidence = c.AssistantEvidence[removed:]
			name = "assistantRuntime"
		case c.UpdateLog != nil && c.UpdateLog.Text != "":
			removed = c.UpdateLog.Lines
			c.UpdateLog.Text, c.UpdateLog.Lines, c.UpdateLog.Truncated = "", 0, true
			name = "updateLog"
		case c.ModelConfig != nil:
			c.ModelConfig = nil
			removed, name = 1, "modelConfig"
		default:
			return nil, kernel.BadAuthRequest("诊断包超过大小限制，请缩短时间范围后重试")
		}
		coverage := c.Collectors[name]
		coverage.Status, coverage.Reason = "truncated", "bundle_byte_limit"
		coverage.Records = max(0, coverage.Records-removed)
		coverage.OmittedAtLeast += int64(removed)
		c.Collectors[name], c.Truncated = coverage, true
	}
}

func trimCount(length int) int { return max(1, length/4) }
