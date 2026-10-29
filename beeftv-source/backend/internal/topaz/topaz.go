// Package topaz defines the canvas parameters for the official upscale gateway.
package topaz

import (
	"errors"
	"math"
)

type Request struct {
	ResourceID          string  `json:"resourceId"`
	ChannelID           string  `json:"channelId"`
	Mode                string  `json:"mode"`
	Model               string  `json:"model"`
	Scale               float64 `json:"scale"`
	OutputFormat        string  `json:"outputFormat,omitempty"`
	EnhancementStrength string  `json:"enhancementStrength,omitempty"`
	ClientOperationID   string  `json:"clientOperationId,omitempty"`
	ProjectID           string  `json:"projectId,omitempty"`
	NodeID              string  `json:"nodeId,omitempty"`
}

type Mode struct {
	MediaType     string   `json:"mediaType"`
	Mode          string   `json:"mode"`
	Models        []string `json:"models"`
	Scales        []int    `json:"scales"`
	OutputFormats []string `json:"outputFormats"`
	FixedScale    int      `json:"fixedScale,omitempty"`
}

func Modes() []Mode {
	return []Mode{
		{"image", "precision", []string{"Standard V2"}, []int{1, 2, 3, 4}, []string{"png", "jpeg"}, 0},
		{"image", "generative", []string{"Wonder 3.5"}, []int{1, 2, 3, 4}, []string{"png", "jpeg"}, 0},
		{"video", "precision", []string{"Proteus"}, []int{1, 2, 3, 4}, []string{"mp4"}, 0},
		{"video", "generative", []string{"Starlight Fast 2"}, []int{1, 2, 3, 4}, []string{"mp4"}, 0},
	}
}

func ModelID(name string) string {
	return map[string]string{"Standard V2": "topaz-standard-v2", "Wonder 3.5": "topaz-wonder-3.5", "Proteus": "topaz-proteus", "Starlight Fast 2": "topaz-starlight-fast-2"}[name]
}

func Validate(r Request, kind string) error {
	if r.ResourceID == "" || r.ChannelID != "beefapi" || math.IsNaN(r.Scale) || math.IsInf(r.Scale, 0) || r.Scale < 1 || r.Scale > 4 || r.Scale != math.Trunc(r.Scale) {
		return errors.New("请选择素材、官方算力及 1–4 倍整数倍率")
	}
	for _, mode := range Modes() {
		if mode.MediaType != kind || mode.Mode != r.Mode || mode.Models[0] != r.Model {
			continue
		}
		if r.OutputFormat != "" {
			found := false
			for _, format := range mode.OutputFormats {
				found = found || format == r.OutputFormat
			}
			if !found {
				return errors.New("输出格式不受支持")
			}
		}
		if r.EnhancementStrength != "" && r.EnhancementStrength != "low" {
			return errors.New("当前超分模型仅支持默认增强强度")
		}
		return nil
	}
	return errors.New("此素材的模式或模型不受支持")
}
