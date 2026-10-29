package diagnostics

// AssistantFailureReasonCodes is the fixed machine-code allowlist shared by
// the SQL projection and export sanitizer. Never return raw error messages.
func AssistantFailureReasonCodes() []string {
	return []string{
		"turn_authorization_unavailable",
		"skill_context_unavailable", "skill_context_service_unavailable",
		"skill_context_model_unavailable", "skill_context_budget_exceeded",
		"skill_context_identity_mismatch", "skill_context_changed",
		"skill_context_pin_unavailable", "skill_context_revision_conflict",
	}
}

func sanitizeAssistantFailureReason(value string) string {
	for _, code := range AssistantFailureReasonCodes() {
		if value == code {
			return code
		}
	}
	return ""
}
