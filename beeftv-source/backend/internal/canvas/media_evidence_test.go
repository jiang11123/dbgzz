package canvas

import "testing"

func TestMediaEvidenceDoesNotConfusePromptWithMedia(t *testing.T) {
	for _, test := range []struct {
		metadata map[string]any
		want     bool
	}{
		{map[string]any{"content": "a private prompt"}, false},
		{map[string]any{"content": "https://example.invalid/clip.mp4"}, true},
		{map[string]any{"content": "/api/resources/owned/file"}, true},
		{map[string]any{"storageKey": "resource:owned"}, true},
		{map[string]any{"content": map[string]any{"prompt": "private"}}, false},
	} {
		if got := NodeHasMedia(map[string]any{"metadata": test.metadata}); got != test.want {
			t.Fatalf("got=%v want=%v", got, test.want)
		}
	}
}
