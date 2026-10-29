package app

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestPublicSeedanceParametersMatchFrontendFixture(t *testing.T) {
	raw := `{"mode":"video","metadata":{"videoEditOperation":"reference_to_video"},"config":{"model":"seedance-2.5","size":"16:9","credentialRef":"beefapi-enterprise","apiKey":"secret-key","headers":{"Authorization":"secret-header"}},"referenceImages":[{"url":"secret-image"}],"referenceVideos":[{"url":"secret-video"}],"referenceAudios":[{"dataUrl":"secret-audio"}]}`
	expected, err := os.ReadFile("../../../web/test/fixtures/seedance-public-input.json")
	if err != nil {
		t.Fatal(err)
	}
	actual := publicTaskInputJSON(raw)
	var want, got any
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(actual), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) || strings.Contains(actual, "secret") {
		t.Fatalf("unsafe or incomplete public input: %s", actual)
	}
}
