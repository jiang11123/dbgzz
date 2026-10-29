package operations

import (
	"encoding/json"
	"os"
	"testing"
)

// This fixture is consumed by the real JS bridge test, rather than a second policy list.
func TestHostPolicyContract(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	descriptors := registry.List(Caller{Kind: CallerManual})
	raw, err := json.MarshalIndent(descriptors, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	const path = "../../../agent-host/operation-descriptors.fixture.json"
	if os.Getenv("UPDATE_HOST_POLICY_FIXTURE") == "1" {
		if err := os.WriteFile(path, raw, 0644); err != nil {
			t.Fatal(err)
		}
	}
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(expected) != string(raw) {
		t.Fatal("host descriptor fixture drift; regenerate with UPDATE_HOST_POLICY_FIXTURE=1")
	}
	for _, id := range []string{"canvas.script.rows.append", "canvas.script.row.update", "canvas.script.row.remove"} {
		op := registry.ops[id]
		if !op.AssistantVisible("canvas") || op.AssistantVisible("read-only") || op.Descriptor().Replay != "safe" {
			t.Fatalf("storyboard policy: %#v", op.Descriptor())
		}
	}
	if (&Op{ID: "unknown"}).AssistantVisible("canvas") || (&Op{}).Descriptor().Replay != "unsafe" {
		t.Fatal("unknown op must be denied in canvas and unsafe to replay")
	}
}
