package app

import (
	"fmt"
	"infinite-canvas/backend/internal/operations"
	"math"
	"strings"
)

type AssistantAttachment struct {
	ResourceID string   `json:"resourceId"`
	Kind       string   `json:"kind"`
	Name       string   `json:"name"`
	MimeType   string   `json:"mimeType"`
	Bytes      int64    `json:"bytes"`
	Purpose    string   `json:"purpose"`
	Start      *float64 `json:"start,omitempty"`
	End        *float64 `json:"end,omitempty"`
	NodeID     string   `json:"nodeId,omitempty"`
	AssetID    string   `json:"assetId,omitempty"`
}

func (s *Service) ValidateAssistantAttachments(userID, canvasID string, items []AssistantAttachment) error {
	if len(items) > 16 {
		return fmt.Errorf("一次最多添加 16 个素材")
	}
	purposes := map[string]bool{"analysis": true, "character": true, "scene": true, "style": true, "motion": true, "first-frame": true, "last-frame": true, "rhythm": true, "sound": true}
	for _, a := range items {
		if a.ResourceID == "" || !purposes[a.Purpose] || len(a.Name) > 512 {
			return fmt.Errorf("素材信息不完整")
		}
		if a.Kind != "image" && a.Kind != "video" && a.Kind != "audio" {
			return fmt.Errorf("不支持的素材类型")
		}
		for _, n := range []*float64{a.Start, a.End} {
			if n != nil && (math.IsNaN(*n) || math.IsInf(*n, 0) || *n < 0 || *n > 86400) {
				return fmt.Errorf("素材片段时间无效")
			}
		}
		if a.Start != nil && a.End != nil && *a.End <= *a.Start {
			return fmt.Errorf("片段结束时间必须晚于开始时间")
		}
		mime, err := operations.ValidateMediaReference(s.BindDomain(nil), userID, canvasID, a.NodeID, a.AssetID, a.ResourceID)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(mime, a.Kind+"/") {
			return fmt.Errorf("素材类型与实际文件不一致")
		}
	}
	return nil
}
