package providerpreset

import (
	"strings"
	"testing"
)

func TestMidjourneyPromptControls(t *testing.T) {
	c, ok := BeefAPIImageContract("midjourney-v8.2")
	if !ok {
		t.Fatal("missing contract")
	}
	for _, preset := range c.Presets {
		if preset.Tier != "1k" {
			t.Fatalf("unpriced tier advertised: %s", preset.Tier)
		}
		got, err := c.GenerationPrompt("a red cube", preset.Size)
		expected := "a red cube"
		if preset.Ratio != "1:1" {
			expected += " --ar " + preset.Ratio
		}
		if err != nil || got != expected {
			t.Fatalf("%s: %q %v", preset.Size, got, err)
		}
	}
	got, err := c.GenerationPrompt("a cube --ar 16:9", "1456x816")
	if err != nil || strings.Count(got, "--ar") != 1 {
		t.Fatalf("duplicate flags: %q %v", got, err)
	}
	for _, prompt := range []string{"a cube --ar 1:1", "a cube --hd", "a cube --q 2", "--ar 16:9", strings.Repeat("x", 2000)} {
		if _, err := c.GenerationPrompt(prompt, "1456x816"); err == nil {
			t.Fatalf("accepted invalid prompt %q", prompt)
		}
	}
	if _, err := c.GenerationPrompt("a cube", "2048x2048"); err == nil {
		t.Fatal("unpriced HD accepted")
	}
}
