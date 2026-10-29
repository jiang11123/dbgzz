package providerpreset

import "testing"

func TestEveryDeclaredVideoContractHasKnownProtocolAndValidLimits(t *testing.T) {
	seen := map[string]bool{}
	for _, contract := range videoContracts {
		if len(contract.Models) == 0 || !knownProtocol(contract.Protocol) {
			t.Fatalf("invalid protocol contract: %#v", contract)
		}
		for _, name := range contract.Models {
			if name == "" || seen[name] {
				t.Fatalf("empty or duplicate model: %q", name)
			}
			seen[name] = true
		}
		for kind, count := range contract.MaxReferences {
			if (kind != "image" && kind != "video" && kind != "audio") || count < 0 {
				t.Fatalf("invalid reference limit: %s=%d", kind, count)
			}
		}
	}
}

func TestVideoContractBoundaries(t *testing.T) {
	for _, name := range []string{"seedance-2.0-fast", "seedance-2.5"} {
		contract, ok := BeefAPIVideoContract(name)
		if !ok || !knownProtocol(contract.Protocol) || !contract.InlineMedia {
			t.Fatalf("missing verified contract for %s", name)
		}
	}
	wan, ok := BeefAPIVideoContract("wan3.0-video")
	if !ok || wan.Protocol != "newapi-channel-2" || wan.InlineMedia || !wan.RequiresHTTPReferences {
		t.Fatalf("Wan must use uploaded HTTP references: %#v", wan)
	}
	for _, name := range []string{"wan3.0-video-prime", "wan4.0-video", "seedance-2.50", "future-video"} {
		if _, ok := BeefAPIVideoContract(name); ok {
			t.Fatalf("unverified model matched: %s", name)
		}
	}
	for _, base := range []string{"https://enterprise.beefapi.com.evil.test", "https://evil.test/enterprise.beefapi.com", "http://enterprise.beefapi.com", "https://user@enterprise.beefapi.com", "https://enterprise.beefapi.com:444"} {
		if IsBeefAPIEndpoint(base) {
			t.Fatalf("untrusted endpoint: %s", base)
		}
	}
	if !IsBeefAPIEndpoint("https://enterprise.beefapi.com/v1") {
		t.Fatal("canonical endpoint rejected")
	}

	capability, protocol, ok := HostedBeefAPIVideoProfile("https://enterprise.beefapi.com", "seedance-2.0-fast")
	if !ok || capability != "video" || protocol != "newapi" {
		t.Fatalf("hosted Fast overlay: cap=%q proto=%q ok=%v", capability, protocol, ok)
	}
	if _, _, ok := HostedBeefAPIVideoProfile("https://example.invalid/v1", "seedance-2.0-fast"); ok {
		t.Fatal("custom gateway must keep its stored capability")
	}
	if _, _, ok := HostedBeefAPIVideoProfile("https://enterprise.beefapi.com", "gpt-image-2"); ok {
		t.Fatal("hosted image SKU must not be rewritten as video")
	}
}
