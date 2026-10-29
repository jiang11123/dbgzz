package modelcatalog

import "testing"

func TestH3ContinuousCatalogMatchesExactFractionalRequests(t *testing.T) {
	config := DefaultModelCapabilityConfigForModel("newapi-channel-2", "minimax-h3-max")
	config.Video.Duration = VideoDurationConfig{Selection: "range", Min: 1, FractionalMin: .92, Max: 15, Step: 1, Default: 5, Continuous: true}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "newapi-channel-2", "minimax-h3-max", config)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		seconds string
		allowed bool
	}{
		{"0.92", true}, {"0.925", true}, {"10.92", true}, {"15", true},
		{"0.919", false}, {"15.001", false}, {"NaN", false}, {"+Inf", false},
	} {
		t.Run(tc.seconds, func(t *testing.T) {
			err := validateVideoTaskParameters(normalized.Video, TaskInput{Prompt: "test", Config: TaskConfig{VideoSeconds: tc.seconds}})
			if (err == nil) != tc.allowed {
				t.Fatalf("duration %s allowed=%t, error=%v", tc.seconds, tc.allowed, err)
			}
		})
	}
	normalized.Video.Duration.Continuous = false
	normalized.Video.Duration.FractionalMin = 0
	if err := validateVideoTaskParameters(normalized.Video, TaskInput{Prompt: "test", Config: TaskConfig{VideoSeconds: "5.5"}}); err == nil {
		t.Fatal("integer-only model accepted fractional duration")
	}
}
