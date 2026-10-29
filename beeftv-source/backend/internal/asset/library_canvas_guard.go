package asset

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type CanvasMediaReference struct {
	AssetID    string
	ResourceID string
}

func CanvasMediaReferences(raw json.RawMessage) ([]CanvasMediaReference, error) {
	var payload struct {
		Nodes []struct {
			Type     string `json:"type"`
			Metadata struct {
				AssetID    string `json:"assetId"`
				StorageKey string `json:"storageKey"`
				Content    string `json:"content"`
			} `json:"metadata"`
		} `json:"nodes"`
		Timeline struct {
			Clips []struct {
				DirectMedia *struct {
					Kind       string `json:"kind"`
					AssetID    string `json:"assetId"`
					StorageKey string `json:"storageKey"`
					URL        string `json:"url"`
					DataURL    string `json:"dataUrl"`
					Content    string `json:"content"`
				} `json:"directMedia"`
			} `json:"clips"`
		} `json:"timeline"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	references := make([]CanvasMediaReference, 0)
	for _, node := range payload.Nodes {
		if !isCanvasMediaKind(node.Type) {
			continue
		}
		resourceID := firstCanvasResourceID(node.Metadata.StorageKey, node.Metadata.Content)
		if resourceID == "" {
			continue
		}
		references = append(references, CanvasMediaReference{
			AssetID: strings.TrimSpace(node.Metadata.AssetID), ResourceID: resourceID,
		})
	}
	for _, clip := range payload.Timeline.Clips {
		media := clip.DirectMedia
		if media == nil || !isCanvasMediaKind(media.Kind) {
			continue
		}
		resourceID := firstCanvasResourceID(media.StorageKey, media.URL, media.DataURL, media.Content)
		if resourceID == "" {
			continue
		}
		references = append(references, CanvasMediaReference{
			AssetID: strings.TrimSpace(media.AssetID), ResourceID: resourceID,
		})
	}
	return references, nil
}

func (l *Library) GuardCanvasReferences(userID string, item model.Asset) error {
	return l.guardCanvasReferences(userID, []model.Asset{item}, false)
}

func (l *Library) GuardReplacementCanvasReferences(userID string, items []model.Asset) error {
	return l.guardCanvasReferences(userID, items, true)
}

func (l *Library) guardCanvasReferences(userID string, items []model.Asset, replacement bool) error {
	if l == nil || l.repo == nil {
		return kernel.NewAppError(kernel.CodeInternal, "素材库暂不可用，请稍后重试")
	}
	byID := make(map[string]model.Asset, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}
	canvases, err := l.repo.CanvasProjects(userID)
	if err != nil {
		return err
	}
	parseMessage := "已有画布媒体数据无法解析，已停止修改素材"
	if replacement {
		parseMessage = "已有画布媒体数据无法解析，已停止替换素材库"
	}
	for _, project := range canvases {
		references, parseErr := CanvasMediaReferences(json.RawMessage(project.PayloadJSON))
		if parseErr != nil {
			return kernel.BadAuthRequest(parseMessage)
		}
		for _, reference := range references {
			if replacement {
				item, exists := byID[reference.AssetID]
				if !exists {
					return kernel.BadAuthRequest("素材仍被画布引用，不能从素材库移除")
				}
				if !assetKeepsCanvasResource(item.PayloadJSON, reference.ResourceID) {
					return kernel.BadAuthRequest("画布媒体与替换后的素材库记录不一致")
				}
				continue
			}
			if reference.AssetID != items[0].ID {
				continue
			}
			if !assetKeepsCanvasResource(items[0].PayloadJSON, reference.ResourceID) {
				return kernel.BadAuthRequest("素材仍被画布引用，不能替换为其他资源")
			}
		}
	}
	return nil
}

func assetKeepsCanvasResource(payloadJSON, resourceID string) bool {
	return assets.DocumentReferences(payloadJSON, map[string]struct{}{resourceID: {}})
}

func firstCanvasResourceID(values ...string) string {
	for _, value := range values {
		if resourceID := assets.ResourceID(value); resourceID != "" {
			return resourceID
		}
	}
	return ""
}

func isCanvasMediaKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image", "video", "audio":
		return true
	default:
		return false
	}
}
