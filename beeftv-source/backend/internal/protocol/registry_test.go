package protocol

import "testing"

type registryMetadataAdapter struct {
	Adapter
	metadata Metadata
}

func (a registryMetadataAdapter) Metadata() Metadata { return a.metadata }

func TestRegistryGeminiCompatibilityPreservesExactProvider(t *testing.T) {
	canonical := registryMetadataAdapter{metadata: Metadata{ID: "gemini-generate-content", Version: "1.0.0"}}
	registry, err := NewRegistry(canonical)
	if err != nil {
		t.Fatal(err)
	}
	const historical = "google-gemini-generate-content"
	if got, ok := registry.Resolve(historical); !ok || got.Metadata().ID != canonical.Metadata().ID {
		t.Fatal("historical catalog value did not resolve the canonical bundled provider")
	}
	exact := registryMetadataAdapter{metadata: Metadata{ID: historical, Version: "1.0.0"}}
	if err := registry.Register(exact); err != nil {
		t.Fatal(err)
	}
	if got, ok := registry.Resolve(historical); !ok || got.Metadata().ID != historical {
		t.Fatal("compatibility fallback shadowed an explicitly installed provider")
	}
}
