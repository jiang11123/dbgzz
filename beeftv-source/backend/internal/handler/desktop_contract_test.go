package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDesktopContractDeclaresLocalOnlyCapabilities(t *testing.T) {
	if DesktopContractVersion != 1 {
		t.Fatalf("desktop contract version = %d, want 1", DesktopContractVersion)
	}
	contract := LocalDesktopContract()
	if contract.Profile != "local" {
		t.Fatalf("desktop profile = %q, want local", contract.Profile)
	}
	if !contract.Capabilities.LocalAssets || !contract.Capabilities.ProviderCalls {
		t.Fatalf("local core capabilities disabled: %#v", contract.Capabilities)
	}
	payload, err := json.Marshal(contract)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(payload)), "billing") {
		t.Fatalf("desktop contract still exposes commerce metadata: %s", payload)
	}
}
