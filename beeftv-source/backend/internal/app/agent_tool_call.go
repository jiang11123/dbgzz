package app

// cloudAgentCall is the JSON shape of assistant tool_calls in canonical
// AgentRequests. provider_test.go and the text tool-call expander share it;
// it is not an old-runtime entrypoint.
type cloudAgentCall struct {
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}
