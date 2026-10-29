package app

import (
	"testing"

	"infinite-canvas/backend/internal/operations"
)

func TestAssistantProductionSeedreamSingleImageConfig(t *testing.T) {
	svc, _, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::seedream-5-0-260128","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["seedream-5-0-260128"],"modelProfiles":[{"model":"seedream-5-0-260128","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	options := map[string]string{"seedreamMode": "image", "seedreamMaxImages": "1", "seedreamOutputFormat": "jpeg", "seedreamOptimize": "fast", "seedreamWatermark": "true"}
	config, err := svc.assistantGenerationConfig(operations.GenerationTarget{Kind: "image", ModelKey: "custom::seedream-5-0-260128", Parameters: options})
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range options {
		if config[k] != v {
			t.Fatalf("confirmed setting %s lost before generation: %+v", k, config)
		}
	}
	if config["model"] != "seedream-5-0-260128" || config["count"] != "1" {
		t.Fatalf("single-image model/count changed: %+v", config)
	}
}
