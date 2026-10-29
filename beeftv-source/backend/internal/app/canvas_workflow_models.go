package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/modelcatalog"
)

// Resolve a public model selection against current owned channel configuration;
// never accept endpoints or credentials supplied in a workflow definition.
func (s *Service) selectWorkflowModel(n cw.Node, recipe *workflowRecipe) (bool, error) {
	option := stringValue(n.Config["modelOption"])
	if option == "" {
		return false, nil
	}
	snapshot, err := s.canvasWorkflowProviderConfig()
	if err != nil {
		return false, err
	}
	raw, _ := json.Marshal(snapshot)
	for _, candidate := range modelcatalog.ParseLocalChannelModels(raw) {
		if !candidate.Enabled || generation.UpscaleMediaType(candidate.Model) != "" || candidate.Capability != n.MediaType || candidate.Protocol == "" || candidate.ChannelID+"::"+candidate.Model != option {
			continue
		}
		old, _ := recipe.Request.Input["config"].(map[string]any)
		recipe.ChannelID = candidate.ChannelID
		if beefapi.IsManagedChannel(candidate.ChannelID, "", candidate.BaseURL) {
			recipe.ChannelID = "@beefapi"
		}
		if stringValue(old["model"]) == candidate.Model && stringValue(old["interfaceType"]) == candidate.Protocol && strings.TrimRight(stringValue(old["baseUrl"]), "/") == strings.TrimRight(candidate.BaseURL, "/") {
			return false, nil
		}
		config := map[string]any{"model": candidate.Model, "interfaceType": candidate.Protocol, "baseUrl": candidate.BaseURL, "capabilityConfig": candidate.CapabilityConfig}
		for _, key := range []string{"size", "quality", "vquality", "videoSeconds", "seed", "generateAudio", "watermark", "count"} {
			if v, ok := old[key]; ok {
				config[key] = v
			}
		}
		recipe.Request.Input["config"] = config
		recipe.Request.Model = candidate.Model
		recipe.Request.Provider = ""
		recipe.Request.LogicalModelID = ""
		return true, nil
	}
	return false, workflowBad("请选择当前已启用、类型匹配的模型")
}
