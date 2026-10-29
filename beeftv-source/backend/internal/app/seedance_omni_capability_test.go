package app

import "testing"

func TestSeedanceOmniOpenAIVideosDefaults(t *testing.T) {
	for _, name := range []string{"seedance-2.0-fast", "seedance-2.5", "seedance-2.5-official"} {
		profile := DefaultModelCapabilityConfigForModel("openai-videos", name).Video
		if profile.References.MaxVideos < 1 || profile.References.MaxAudios < 1 || !containsCapabilityString(profile.Operations, "reference_to_video") {
			t.Fatalf("%s omitted multimodal capabilities", name)
		}
	}
}
