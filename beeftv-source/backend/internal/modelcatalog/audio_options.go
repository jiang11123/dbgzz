package modelcatalog

import (
	"strings"

	"infinite-canvas/backend/internal/model"
)

// AudioGenerationOptions describes choices exposed by the current speech path.
// Recommended voices are examples, not a closed validation list for custom IDs.
type AudioGenerationOptions struct {
	DefaultVoice          string             `json:"defaultVoice"`
	DefaultFormat         string             `json:"defaultFormat"`
	AllowCustomVoice      bool               `json:"allowCustomVoice"`
	Speed                 AudioSpeedOptions  `json:"speed"`
	Voices                []AudioVoiceOption `json:"voices"`
	InstructionsSupported bool               `json:"instructionsSupported"`
	Guidance              string             `json:"guidance"`
	Source                string             `json:"source"`
}

type AudioSpeedOptions struct {
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Default float64 `json:"default"`
}

type AudioVoiceOption struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Gender      string `json:"gender"`
	Language    string `json:"language"`
	Description string `json:"description"`
}

func audioGenerationOptions(cm *model.ChannelModel) *AudioGenerationOptions {
	_, name := SplitModelKey(cm.ModelKey)
	if cm.Capability != "audio" || cm.Protocol != model.ChannelInterfaceOpenAIAudio || !strings.HasPrefix(strings.ToLower(name), "minimax-speech-") {
		return nil
	}
	return &AudioGenerationOptions{
		DefaultVoice: "male-qn-qingse", DefaultFormat: "mp3", AllowCustomVoice: true,
		Speed: AudioSpeedOptions{Min: 0.5, Max: 2, Default: 1},
		Voices: []AudioVoiceOption{
			{ID: "male-qn-qingse", Name: "青涩青年", Gender: "male", Language: "zh-CN", Description: "青年男声"},
			{ID: "male-qn-jingying", Name: "精英青年", Gender: "male", Language: "zh-CN", Description: "成熟、专业男声"},
			{ID: "Chinese (Mandarin)_Gentleman", Name: "温润男声", Gender: "male", Language: "zh-CN", Description: "适合平静旁白与叙事"},
			{ID: "female-tianmei", Name: "甜美女性", Gender: "female", Language: "zh-CN", Description: "适合柔和、亲切的内容"},
			{ID: "female-chengshu", Name: "成熟女性", Gender: "female", Language: "zh-CN", Description: "成年女声"},
			{ID: "Chinese (Mandarin)_Soft_Girl", Name: "柔和少女", Gender: "female", Language: "zh-CN", Description: "适合安静、舒缓的内容"},
		},
		InstructionsSupported: false,
		Guidance:              "audioVoice 使用推荐列表中的真实 ID，或用户提供的有效自定义音色 ID；不要根据自然语言风格编造 ID。当前 MiniMax speech 兼容路径未接入 audioInstructions 自由朗读指令，不能依赖它控制情绪或音高；用音色与 audioSpeed 选择表达，混音音量在时间线设置。prompt 只放要读出的台词，不要混入朗读要求。推荐音色来自官方目录，实际可用性由配置的渠道决定。",
		Source:                "https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/references/minimax-voice-catalog.md",
	}
}
