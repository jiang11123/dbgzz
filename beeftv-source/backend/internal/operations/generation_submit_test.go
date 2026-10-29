package operations

import (
	"encoding/json"
	"testing"
)

type mixedGenerationProbe struct {
	proposeProbe
	admitted []GenerationTarget
}

func (p *mixedGenerationProbe) SubmitAuthorizedGeneration(_, _, _ string, targets []GenerationTarget) (any, error) {
	p.admitted = targets
	return map[string]any{"taskIds": []string{"video-task", "voice-task"}}, nil
}

func TestGenerationSubmitMixedReadyTargetsAndDependencyRejection(t *testing.T) {
	for _, pending := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "pending-reference"}[pending], func(t *testing.T) {
			frame := imageNode("frame", "image")
			if !pending {
				frame["metadata"].(map[string]any)["storageKey"] = "resource:frame"
			}
			video := imageNode("video", "video")
			video["type"] = "video"
			video["metadata"].(map[string]any)["videoStartFrameNodeId"] = "frame"
			voice := imageNode("voice", "speech")
			voice["type"] = "audio"
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{frame, video, voice})}}
			p.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["video","voice"]}`))
			if pending {
				if err == nil || len(p.admitted) != 0 {
					t.Fatal("unready dependency admitted paid work", err)
				}
			} else if err != nil || len(p.admitted) != 2 || p.admitted[0].Kind != "video" || p.admitted[1].Kind != "audio" {
				t.Fatalf("mixed admission: %+v %v", p.admitted, err)
			}
		})
	}
}

func TestProductionSeedreamUnsupportedOutputsNeverReachAdmission(t *testing.T) {
	for _, tc := range []struct{ name, model, mode, max string }{
		{"layers", "custom::dola-seedream-5-0-pro-260128", "layers", "1"},
		{"flash-layers", "dola-seedream-5-0-flash-260128", "layers", "1"},
		{"group", "custom::seedream-4-5-251128", "image", "4"},
		{"lite-group", "custom::seedream-5-0-260128", "image", "2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := imageNode("image", tc.model)
			meta := n["metadata"].(map[string]any)
			meta["seedreamMode"], meta["seedreamMaxImages"] = tc.mode, tc.max
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{n})}}
			p.resolve = func(_, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{Display: selected, ModelKey: selected}, nil
			}
			for _, propose := range []bool{true, false} {
				var result any
				var err error
				ctx := &Context{TurnID: "turn", UserID: "owner", Domain: p}
				if propose {
					result, err = opCanvasGenerationPropose(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"],"kind":"image","productionNodeIds":["image"]}`))
				} else {
					result, err = opGenerationSubmit(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"]}`))
				}
				if err == nil || AsError(err).Reason != "production_seedream_multiple_outputs" || result != nil || len(p.admitted) != 0 {
					t.Fatalf("unsupported combination reached paid admission (propose=%v): result=%v targets=%+v err=%v", propose, result, p.admitted, err)
				}
			}
		})
	}
}

func TestProductionSeedreamSingleImageKeepsConfirmedOptions(t *testing.T) {
	for _, model := range []string{"custom::seedream-5-0-260128", "custom::dola-seedream-5-0-pro-260128", "custom::other-image"} {
		t.Run(model, func(t *testing.T) {
			n := imageNode("image", model)
			meta := n["metadata"].(map[string]any)
			options := map[string]string{"seedreamMode": "image", "seedreamMaxImages": "1", "seedreamOutputFormat": "jpeg", "seedreamOptimize": "fast", "seedreamWatermark": "true"}
			for k, v := range options {
				meta[k] = v
			}
			if model == "custom::other-image" {
				meta["seedreamMode"], meta["seedreamMaxImages"] = "layers", "4"
			}
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{n})}}
			p.resolve = func(_, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"]}`))
			if err != nil || len(p.admitted) != 1 {
				t.Fatalf("single-image admission: %+v %v", p.admitted, err)
			}
			for k, v := range options {
				want := v
				if model == "custom::other-image" {
					want = ""
				}
				if got := p.admitted[0].Parameters[k]; got != want {
					t.Fatalf("confirmed %s changed: got %q want %q", k, got, want)
				}
			}
		})
	}
}
