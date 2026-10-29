package canvasworkflow

import (
	"fmt"
	"infinite-canvas/backend/internal/topaz"
	"strings"
)

func ImageWorkflowOperations() []Operation {
	one, four := 1.0, 4.0
	out := []Operation{
		{ID: "image.select", Version: 1, Name: "选择图片结果", OutputType: "image", Inputs: []InputPort{{"images", "候选图片", "image", true, true}}},
		{ID: "image.describe", Version: 1, Name: "反推提示词", OutputType: "text", Inputs: []InputPort{{"image", "参考图片", "image", true, false}}, Fields: []Field{{Key: "modelOption", Label: "识图模型", Type: "select"}, {Key: "prompt", Label: "反推要求", Type: "textarea"}}},
	}
	for _, kind := range []string{"image", "video"} {
		name, format := "AI超分", "png"
		if kind == "video" {
			name, format = "AI超分", "mp4"
		}
		presets := []FieldOption{}
		for _, mode := range topaz.Modes() {
			if mode.MediaType != kind {
				continue
			}
			label := map[string]string{"precision": "保真增强", "generative": "细节重建", "transparent": "透明图片"}[mode.Mode]
			for _, model := range mode.Models {
				presets = append(presets, FieldOption{Label: label + " · " + model, Value: mode.Mode + "|" + model})
			}
		}
		formats := []FieldOption{{Label: strings.ToUpper(format), Value: format}}
		if kind == "image" {
			formats = append(formats, FieldOption{Label: "JPEG", Value: "jpeg"})
		}
		out = append(out, Operation{ID: kind + ".ai-upscale", Version: 1, Name: name, OutputType: kind,
			Inputs: []InputPort{{kind, map[string]string{"image": "图片", "video": "视频"}[kind], kind, true, false}},
			Fields: []Field{{Key: "channelId", Label: "超分渠道", Type: "select"}, {Key: "preset", Label: "超分模型", Type: "select", Options: presets}, {Key: "scale", Label: "放大倍率", Type: "number", Min: &one, Max: &four}, {Key: "outputFormat", Label: "输出格式", Type: "select", Options: formats}},
		})
	}
	return out
}

func UpscaleRequest(n Node) (topaz.Request, error) {
	preset, _ := n.Config["preset"].(string)
	parts := strings.SplitN(preset, "|", 2)
	if len(parts) != 2 {
		return topaz.Request{}, fmt.Errorf("请选择超分模型")
	}
	channel, _ := n.Config["channelId"].(string)
	format, _ := n.Config["outputFormat"].(string)
	r := topaz.Request{ResourceID: "workflow-input", ChannelID: channel, Mode: parts[0], Model: parts[1], Scale: operationNumber(n.Config["scale"]), OutputFormat: format}
	return r, topaz.Validate(r, n.MediaType)
}
