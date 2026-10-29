package provider

import "testing"

func TestManifestValidationAndRegistryIsolation(t *testing.T) {
	valid := Manifest{SchemaVersion: 1, ID: "openai-compatible", Version: "1.0.0", Capabilities: []string{"text", "image"}, InlineMedia: InlineMediaReject}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	if err := registry.RegisterManifest(valid); err != nil {
		t.Fatal(err)
	}
	if got, ok := registry.ResolveManifest(valid.ID); !ok || got.Version != valid.Version {
		t.Fatalf("ResolveManifest = (%+v, %v)", got, ok)
	}
	if _, ok := NewRegistry().ResolveManifest(valid.ID); ok {
		t.Fatal("provider registry leaked across app instances")
	}

	invalid := []Manifest{
		{},
		{SchemaVersion: 2, ID: "future", Version: "1", Capabilities: []string{"text"}, InlineMedia: InlineMediaReject},
		{SchemaVersion: 1, ID: "bad", Version: "1", Capabilities: []string{"billing"}, InlineMedia: InlineMediaReject},
		{SchemaVersion: 1, ID: "bad-inline", Version: "1", Capabilities: []string{"image"}, InlineMedia: "allow-remote"},
	}
	for _, manifest := range invalid {
		if err := manifest.Validate(); err == nil {
			t.Fatalf("invalid manifest accepted: %+v", manifest)
		}
	}
}
