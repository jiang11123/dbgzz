package topaz

import "testing"

func TestOfficialUpscaleParameters(t *testing.T) {
	for _, mode := range Modes() {
		r := Request{ResourceID: "owned", ChannelID: "beefapi", Mode: mode.Mode, Model: mode.Models[0], Scale: 2, OutputFormat: mode.OutputFormats[0]}
		if err := Validate(r, mode.MediaType); err != nil {
			t.Fatal(err)
		}
		if ModelID(r.Model) == "" {
			t.Fatal("missing official model mapping")
		}
		r.ChannelID = "fal"
		if Validate(r, mode.MediaType) == nil {
			t.Fatal("direct provider credential accepted")
		}
		r.ChannelID, r.Scale = "beefapi", 1.5
		if Validate(r, mode.MediaType) == nil {
			t.Fatal("unsupported fractional scale accepted")
		}
	}
}
