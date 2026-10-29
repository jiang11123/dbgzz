package app

import (
	"encoding/json"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"sort"
	"strings"
)

func (s *Service) prepareSeedreamOutputNodes(task model.Task) error {
	root := localtask.SeedreamOutputRoot(task)
	if root == "" || task.ProjectID == "" {
		return nil
	}
	outputs, err := s.generationDeliverer().LoadedOutputs(task.ID)
	if err != nil {
		return err
	}
	if len(outputs) < 2 {
		return nil
	}
	var result struct {
		Layers []map[string]any `json:"imageLayers"`
	}
	_ = json.Unmarshal([]byte(task.ResultJSON), &result)
	layers := map[int]map[string]any{}
	for _, layer := range result.Layers {
		if index, ok := layer["imageIndex"].(float64); ok {
			layers[int(index)] = layer
		}
	}
	patches := make([]canvas.TaskOutputBind, 0, len(outputs))
	for _, output := range outputs {
		nodeID := localtask.SeedreamOutputNodeID(task, output.OutputIndex)
		if nodeID == "" || output.MediaType != "image" || output.MaterializedAssetID == "" || output.ResourceID == "" {
			continue
		}
		resource, e := s.repo.ResourceForUser(task.UserID, output.ResourceID)
		if e != nil {
			return e
		}
		asset, e := s.repo.AssetForUser(task.UserID, output.MaterializedAssetID)
		if e != nil {
			return e
		}
		if resource.Status != model.ResourceStatusReady || asset.UserID != task.UserID || resource.UserID != task.UserID {
			continue
		}
		var payload struct {
			Data struct {
				StorageKey string `json:"storageKey"`
				URL        string `json:"url"`
				DataURL    string `json:"dataUrl"`
			} `json:"data"`
		}
		if json.Unmarshal([]byte(asset.PayloadJSON), &payload) != nil {
			continue
		}
		owned := false
		for _, value := range []string{payload.Data.StorageKey, payload.Data.URL, payload.Data.DataURL} {
			owned = owned || assets.ResourceID(value) == resource.ID
		}
		if !owned || !strings.HasPrefix(resource.MimeType, "image/") {
			continue
		}
		patches = append(patches, canvas.TaskOutputBind{CanvasID: task.ProjectID, NodeID: nodeID, TaskID: task.ID, TaskType: task.Type, OutputIndex: output.OutputIndex, EffectKey: localtask.AttachNodeEffectKey(task.ID, nodeID, output.OutputIndex), MediaType: "image", AssetID: asset.ID, ResourceID: resource.ID, StorageKey: "resource:" + resource.ID, Content: assets.FileURL(resource.ID), MimeType: resource.MimeType, Bytes: resource.Size, Width: resource.Width, Height: resource.Height})
	}
	sort.Slice(patches, func(i, j int) bool { return patches[i].OutputIndex < patches[j].OutputIndex })
	return s.canvasDomain().PrepareSeedreamOutputs(task.UserID, task.ProjectID, root, task.ID, patches, layers)
}
