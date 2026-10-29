package modelcatalog

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	"infinite-canvas/backend/internal/kernel"
)

// Endpoint-specific contracts; see docs/content/docs/backend/video-prompt-limits.mdx.
// Keep the same cases as web/src/lib/video-prompt-limits.ts.
func videoPromptLimits(protocol, modelName string) (chars, utf16Units int) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(modelName)), "/")
	name := parts[len(parts)-1]
	match := func(pattern string) bool { return regexp.MustCompile(pattern).MatchString(name) }
	switch protocol {
	case "full-video":
		chars = 4000
	case "openai", "openai-videos", "newapi":
		if match(`^sora-2(?:-pro)?$`) {
			chars = 32000
		}
	case "minimax-video":
		if name == "minimax-h3" || name == "minimax-h3-max" {
			chars = 7000
		}
	case "dashscope-wan-video":
		if match(`^wan3[.-]0`) {
			chars = 20000
		} else if match(`^wan2[.-]7`) {
			chars = 5000
		} else if match(`^wan2[.-][56]`) {
			chars = 1500
		} else if match(`^wan2[.-][12]`) {
			chars = 800
		}
	case "volcengine-jimeng-video":
		if name == "jimeng_t2v_v30" {
			chars = 800
		}
	case "luma-dream-machine":
		if name == "ray-2" || name == "ray-flash-2" {
			chars = 5000
		}
	case "pixverse-video":
		switch name {
		case "v6-max", "c1", "v6", "v3.5", "v4", "v4.5", "v5", "v5-fast", "v5.5", "v5.6":
			chars = 5000
		}
	case "zhipu-cogvideox":
		switch name {
		case "cogvideox-3", "cogvideox-2", "cogvideox-flash", "viduq1-text", "viduq1-image", "vidu2-image", "viduq1-start-end", "vidu2-start-end", "vidu2-reference":
			chars = 512
		}
	case "runway-video":
		switch name {
		case "gen4.5", "gen4_turbo", "veo3.1", "veo3.1_fast":
			utf16Units = 1000
		case "happyhorse_1_0":
			utf16Units = 2500
		case "seedance2_5":
			chars = 15000
		case "seedance2", "seedance2_fast", "seedance2_mini":
			chars = 3500
		case "hailuo3", "h3_max":
			chars = 6000
		case "klingo3_4k", "kling3.0_4k", "kling2.5_turbo_pro", "kling3.0_pro", "kling3.0_standard", "klingo3_pro", "klingo3_standard", "grok_imagine_1_5", "grok_imagine_1_5_lite":
			chars = 2500
		case "wan3", "wan3_prime":
			chars = 20000
		case "gemini_omni_flash", "gemini_omni_flash_1.1":
			chars = 4000
		}
	}
	return
}

func validateVideoPromptLength(prompt string, references VideoReferenceConfig) error {
	if err := validateModelPromptLength("视频", prompt, references.PromptMaxChars); err != nil {
		return err
	}
	if max := references.PromptMaxUTF16Units; max > 0 {
		if actual := len(utf16.Encode([]rune(prompt))); actual > max {
			return kernel.BadAuthRequest(fmt.Sprintf("当前视频通道提示词最多 %d 个 UTF-16 单位（部分表情占 2 个），完整提示词为 %d 个单位。请精简后重试", max, actual))
		}
	}
	return nil
}
