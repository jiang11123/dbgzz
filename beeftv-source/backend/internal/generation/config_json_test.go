package generation

import (
	"encoding/json"
	"testing"
)

func TestPersistedScalarConfigCanBeRetried(t *testing.T) {
	for _, flag := range []string{"true", "false", `"true"`, `"false"`} {
		var input Input
		raw := `{"mode":"video","config":{"model":"seedance-2.0-mini","interfaceType":"newapi","videoGenerateAudio":` + flag + `,"videoWatermark":false,"videoSeconds":6,"count":1,"audioSpeed":1.25,"runningHubUseWallet":true}}`
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			t.Fatal(err)
		}
		want := flag
		if flag[0] == '"' {
			want = flag[1 : len(flag)-1]
		}
		if input.Config.VideoGenerateAudio != want || input.Config.VideoWatermark != "false" || input.Config.VideoSeconds != "6" || input.Config.Count != "1" || input.Config.AudioSpeed != "1.25" || !input.Config.RunningHubUseWallet {
			t.Fatalf("lost options: %#v", input.Config)
		}
		encoded, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		var replay Input
		if err := json.Unmarshal(encoded, &replay); err != nil || replay.Config.VideoGenerateAudio != want {
			t.Fatalf("replay: %v", err)
		}
	}
}

func TestConfigRejectsNonScalarOrWrongTypedFields(t *testing.T) {
	for _, raw := range []string{`{"videoGenerateAudio":{}}`, `{"videoGenerateAudio":1}`, `{"videoSeconds":false}`, `{"apiKey":true}`, `{"model":2}`, `{"headers":"secret"}`} {
		var config Config
		if json.Unmarshal([]byte(raw), &config) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
