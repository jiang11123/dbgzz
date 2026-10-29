package appearance

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func jsonMarshalSetting(value Setting) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func TestPublicProjectionHidesResourceIDsAndSkinLibrary(t *testing.T) {
	value := DefaultSetting()
	value.BrandName = "HIMA Studio"
	value.BrandSlug = "hima-studio"
	value.LogoResourceID = "brand-logo"
	value.AuthVideoResourceID = "brand-video"
	value.SkinID = "studio-indigo"
	value.SkinThemes = DefaultSkinThemes()
	public := publicSetting(&model.SystemSetting{UpdatedAt: time.Unix(1, 0).UTC()}, value)
	encoded, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	if strings.Contains(body, "brand-logo") || strings.Contains(body, "brand-video") || strings.Contains(body, "skinThemes") {
		t.Fatalf("public projection leaked internals: %s", body)
	}
	if !strings.HasPrefix(public.LogoURL, "/api/public/appearance/assets/") || public.AuthVideoPosterURL != "" {
		t.Fatalf("public projection = %#v", public)
	}
}

func TestBuiltInSkinTooltipPairsMeetContrast(t *testing.T) {
	for _, skin := range DefaultSkinThemes() {
		for _, mode := range []struct {
			name   string
			tokens AppearanceSkinModeTokens
		}{
			{name: "light", tokens: skin.Tokens.Light},
			{name: "dark", tokens: skin.Tokens.Dark},
		} {
			ratio := appearanceColorContrastRatio(t, mode.tokens.Overlay, mode.tokens.Text)
			if ratio < 4.5 {
				t.Errorf("skin %s %s tooltip contrast = %.2f, want at least 4.5", skin.ID, mode.name, ratio)
			}
		}
	}
}

func appearanceColorContrastRatio(t *testing.T, foreground, background string) float64 {
	t.Helper()
	contrastLuminance := func(color string) float64 {
		if len(color) != 7 || color[0] != '#' {
			t.Fatalf("unsupported test color %q", color)
		}
		channels := make([]float64, 3)
		for index := range channels {
			value, err := strconv.ParseUint(color[1+index*2:3+index*2], 16, 8)
			if err != nil {
				t.Fatalf("parse test color %q: %v", color, err)
			}
			srgb := float64(value) / 255
			if srgb <= 0.04045 {
				channels[index] = srgb / 12.92
			} else {
				channels[index] = math.Pow((srgb+0.055)/1.055, 2.4)
			}
		}
		return 0.2126*channels[0] + 0.7152*channels[1] + 0.0722*channels[2]
	}
	foregroundLuminance := contrastLuminance(foreground)
	backgroundLuminance := contrastLuminance(background)
	lighter := math.Max(foregroundLuminance, backgroundLuminance)
	darker := math.Min(foregroundLuminance, backgroundLuminance)
	return (lighter + 0.05) / (darker + 0.05)
}
