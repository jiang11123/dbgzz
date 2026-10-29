package modelcatalog

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWorkflowReferenceShapeDefersOnlyMediaMetadata(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.0").Video
	input := TaskInput{Mode: "video", ReferenceImages: []MediaRef{{}}, ReferenceAudios: []MediaRef{{}}}
	if err := validateVideoReferenceMedia(profile, input); err == nil {
		t.Fatal("runtime accepted missing audio duration")
	}
	input.DeferReferenceMetadata = true
	if err := validateVideoReferenceMedia(profile, input); err != nil {
		t.Fatal(err)
	}
	input.ReferenceAudios = make([]MediaRef, profile.References.MaxAudios+1)
	if err := validateVideoReferenceMedia(profile, input); err == nil || !strings.Contains(err.Error(), "参考音频") {
		t.Fatalf("count limit bypassed: %v", err)
	}
	var decoded TaskInput
	if err := json.Unmarshal([]byte(`{"DeferReferenceMetadata":true}`), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.DeferReferenceMetadata {
		t.Fatal("request enabled template-only validation")
	}
}
