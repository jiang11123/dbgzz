package providerpreset

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

var mjRatioFlag = regexp.MustCompile(`(?i)(?:^|\s)--(?:ar|aspect)\b(?:\s+([^\s]+))?`)
var mjUnsupportedFlag = regexp.MustCompile(`(?i)--(?:sd|q|quality|hd|draft|turbo|fast|relax|repeat|r|v|version|niji)(?:\s|=|$)`)

// The priced gateway model supports native standard output; only framing is encoded in the prompt.
func (c ImageContract) GenerationPrompt(prompt, size string) (string, error) {
	if c.Model != "midjourney-v8.2" || len(c.Presets) == 0 {
		return prompt, nil
	}
	pixels, err := c.PixelSize(size)
	if err != nil {
		return "", err
	}
	var selected ImagePreset
	for _, preset := range c.Presets {
		if preset.Size == pixels {
			selected = preset
			break
		}
	}
	if selected.Size == "" {
		return "", fmt.Errorf("当前 Midjourney 不支持所选尺寸")
	}
	for _, match := range mjRatioFlag.FindAllStringSubmatch(prompt, -1) {
		if match[1] != selected.Ratio {
			return "", fmt.Errorf("提示词中的 --ar/--aspect 与宽高比选项冲突，请统一后提交")
		}
	}
	if mjUnsupportedFlag.MatchString(prompt) {
		return "", fmt.Errorf("当前官方 Midjourney 渠道仅支持原生标准档，不支持 HD、质量、速度、版本或重复参数")
	}
	prompt = mjRatioFlag.ReplaceAllString(prompt, " ")
	if strings.TrimSpace(prompt) == "" {
		return "", fmt.Errorf("请输入图片内容描述")
	}
	prompt = strings.TrimSpace(prompt)
	if selected.Ratio != "1:1" {
		prompt += " --ar " + selected.Ratio
	}
	if utf8.RuneCountInString(prompt) > c.PromptMaxChars {
		return "", fmt.Errorf("含画幅和分辨率参数的提示词超过 %d 字符", c.PromptMaxChars)
	}
	return prompt, nil
}
