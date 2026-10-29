package assistant

import "testing"

func TestProviderFingerprintTracksEveryField(t *testing.T) {
	base := Provider{ChannelID: "beefapi", Model: "MiniMax-M3",
		BaseURL: "https://enterprise.beefapi.com/v1", Protocol: "chat-completion", APIKey: "one"}
	variants := []Provider{
		{ChannelID: "other", Model: base.Model, BaseURL: base.BaseURL, Protocol: base.Protocol, APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: "claude-fable-5", BaseURL: base.BaseURL, Protocol: base.Protocol, APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: base.Model, BaseURL: "https://other.example/v1", Protocol: base.Protocol, APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: base.Model, BaseURL: base.BaseURL, Protocol: "claude-api", APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: base.Model, BaseURL: base.BaseURL, Protocol: base.Protocol, APIKey: "two"},
	}
	for _, variant := range variants {
		if variant.Fingerprint() == base.Fingerprint() {
			t.Fatalf("指纹未随字段变化: %#v", variant)
		}
	}
	if base.Fingerprint() != (Provider{ChannelID: "beefapi", Model: "MiniMax-M3",
		BaseURL: "https://enterprise.beefapi.com/v1", Protocol: "chat-completion", APIKey: "one"}).Fingerprint() {
		t.Fatal("相同配置应得到相同指纹")
	}
}
