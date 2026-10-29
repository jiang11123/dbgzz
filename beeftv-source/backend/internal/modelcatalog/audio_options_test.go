package modelcatalog

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestMiniMaxSpeechCatalogProvidesRealVoicesAndInstructionLimits(t *testing.T) {
	for _, name := range []string{"minimax-speech-2.8-turbo", "beefapi::minimax-speech-2.8-hd"} {
		t.Run(name, func(t *testing.T) {
			public, err := SanitizeChannelModel(&model.ChannelModel{ModelKey: name, Capability: "audio", Protocol: model.ChannelInterfaceOpenAIAudio, Enabled: true})
			if err != nil {
				t.Fatal(err)
			}
			wire, err := json.Marshal(public)
			if err != nil {
				t.Fatal(err)
			}
			var decoded struct {
				AudioOptions *struct {
					DefaultVoice          string                                  `json:"defaultVoice"`
					DefaultFormat         string                                  `json:"defaultFormat"`
					AllowCustomVoice      bool                                    `json:"allowCustomVoice"`
					InstructionsSupported bool                                    `json:"instructionsSupported"`
					Guidance              string                                  `json:"guidance"`
					Speed                 struct{ Min, Max, Default float64 }     `json:"speed"`
					Voices                []struct{ ID, Gender, Language string } `json:"voices"`
				} `json:"audioOptions"`
			}
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatal(err)
			}
			options := decoded.AudioOptions
			if options == nil {
				t.Fatal("speech catalog is missing audioOptions; the agent cannot select a real voice")
			}
			if options.DefaultVoice != "male-qn-qingse" || options.DefaultFormat != "mp3" || options.Speed.Min != 0.5 || options.Speed.Max != 2 || options.Speed.Default != 1 {
				t.Fatalf("wrong speech defaults: %#v", options)
			}
			if !options.AllowCustomVoice || options.InstructionsSupported || options.Guidance == "" {
				t.Fatalf("voice/instruction support must be explicit: %#v", options)
			}
			voices := map[string]string{}
			for _, voice := range options.Voices {
				if voice.Language != "zh-CN" {
					t.Fatalf("wrong language: %#v", voice)
				}
				voices[voice.ID] = voice.Gender
			}
			if voices[options.DefaultVoice] != "male" || voices["female-tianmei"] != "female" || voices["Chinese (Mandarin)_Soft_Girl"] != "female" || voices["Chinese (Mandarin)_Gentleman"] != "male" || voices["female-gentle"] != "" {
				t.Fatalf("missing real Chinese voice choices or fabricated voice: %#v", voices)
			}
		})
	}
}

func TestMiniMaxSpeechOptionsDoNotChangeOtherAudioContracts(t *testing.T) {
	for _, test := range []struct{ name, capability, protocol string }{
		{"minimax-music-v3.0", "audio", "openai-audio"},
		{"gpt-4o-mini-tts", "audio", "openai-audio"},
		{"customer-speech", "audio", "openai-audio"},
		{"minimax-speech-2.8-hd", "audio", "custom-audio"},
	} {
		t.Run(test.name+"/"+test.protocol+"/"+test.capability, func(t *testing.T) {
			public, err := SanitizeChannelModel(&model.ChannelModel{ModelKey: test.name, Capability: test.capability, Protocol: model.ChannelInterfaceType(test.protocol), Enabled: true})
			if err != nil {
				t.Fatal(err)
			}
			wire, _ := json.Marshal(public)
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(wire, &fields); err != nil {
				t.Fatal(err)
			}
			if _, exists := fields["audioOptions"]; exists {
				t.Fatalf("MiniMax voice advice leaked into another contract: %s", wire)
			}
		})
	}
}
