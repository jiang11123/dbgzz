package workflow

// RootURL normalizes a configured RunningHub base URL to the OpenAPI root.
func RootURL(value string) string { return runningHubRootURL(value) }

// APIKey is the credit-key used for workflow submit/poll (not the upload key).
func APIKey(config Config) string { return runningHubAPIKey(config) }

func PayloadCode(payload map[string]any) (int, bool) { return runningHubPayloadCode(payload) }

func FailureMessage(payload map[string]any) string { return runningHubFailureMessage(payload) }

func TaskID(payload map[string]any) string { return runningHubTaskID(payload) }

func FileName(payload map[string]any) string { return runningHubFileName(payload) }

func OutputURLs(value interface{}) []string { return runningHubOutputURLs(value) }

func ResolveOutputURL(root string, rawURL string) string {
	return resolveRunningHubOutputURL(root, rawURL)
}

func PromptFallback(workflow map[string]interface{}, prompt string) []map[string]any {
	return runningHubPromptFallback(workflow, prompt)
}

func IsLinkValue(value interface{}) bool { return isWorkflowLinkValue(value) }

func NodeMetaTitle(node map[string]interface{}) string { return workflowNodeMetaTitle(node) }

func IsPromptFieldName(value string) bool { return isWorkflowPromptFieldName(value) }

func FieldsFromManagement(workflow map[string]interface{}, mode string) ([]Field, error) {
	return workflowFieldsFromManagement(workflow, mode)
}

func FieldsForMode(fields []Field, mode string) []Field {
	return workflowFieldsForMode(fields, mode)
}
