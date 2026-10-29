package modelcatalog

import "testing"

func TestMediaReviewSelectionUsesItsOwnRoleAndSelectedCredential(t *testing.T) {
	channel := AssistantChannel{ID: "beefapi", Pinned: true, Enabled: true, CredentialRef: "beefapi-enterprise",
		BaseURL: "https://example.test", Models: []string{MediaReviewModel},
		ModelProfiles: []AssistantModelProfile{{Model: MediaReviewModel, Capability: "text", Protocol: "chat-completion"}}}
	snapshot := AssistantConfigSnapshot{MediaReviewModel: "beefapi::" + MediaReviewModel, Channels: []AssistantChannel{channel}}
	lookups := 0
	lookup := func(id, ref, url string) (string, string, bool) {
		lookups++
		if id != channel.ID || ref != channel.CredentialRef {
			t.Fatal("wrong selected credential")
		}
		return "synthetic-key", "https://selected.example.test/v1", true
	}
	provider, reason := ResolveMediaReviewProvider(snapshot, lookup)
	if reason != "" || provider.Model != MediaReviewModel || provider.APIKey != "synthetic-key" || provider.BaseURL != "https://selected.example.test/v1" || lookups != 1 {
		t.Fatal("selected managed media model did not resolve")
	}
	if _, reason := ResolveAssistantChannelModel(snapshot, snapshot.MediaReviewModel, lookup); reason == "" {
		t.Fatal("media role must not grant main assistant access")
	}
	for _, change := range []func(*AssistantConfigSnapshot){
		func(s *AssistantConfigSnapshot) { s.MediaReviewModel = "" },
		func(s *AssistantConfigSnapshot) { s.MediaReviewModel = "missing::" + MediaReviewModel },
		func(s *AssistantConfigSnapshot) { s.Channels[0].Enabled = false },
		func(s *AssistantConfigSnapshot) { s.Channels[0].Models = []string{"other"} },
		func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: MediaReviewModel, Capability: "text", Protocol: "responses"}}
		},
		func(s *AssistantConfigSnapshot) { s.MediaReviewModel = "beefapi::gpt-6-astra" },
	} {
		s := snapshot
		s.Channels = []AssistantChannel{channel}
		change(&s)
		if got, reason := ResolveMediaReviewProvider(s, lookup); reason == "" || got.APIKey != "" {
			t.Fatal("invalid choice accepted or credential exposed")
		}
	}
	if lookups != 1 {
		t.Fatal("invalid choices must not look up credentials")
	}
	snapshot.Channels[0].ModelAliases = map[string]string{MediaReviewModel: "catalog-wand"}
	snapshot.Channels[0].Models = []string{"catalog-wand"}
	snapshot.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "catalog-wand", Capability: "text", Protocol: "chat-completion"}}
	provider, reason = ResolveMediaReviewProvider(snapshot, lookup)
	if reason != "" || provider.Model != "catalog-wand" {
		t.Fatal("configured catalog alias was not used")
	}
}
