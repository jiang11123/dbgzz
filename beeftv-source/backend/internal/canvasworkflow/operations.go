package canvasworkflow

import (
	"fmt"
	"math"
	"strings"
)

type InputPort struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	MediaType string `json:"mediaType"`
	Required  bool   `json:"required"`
	Multiple  bool   `json:"multiple"`
}
type Field struct {
	Key     string        `json:"key"`
	Label   string        `json:"label"`
	Type    string        `json:"type"`
	Min     *float64      `json:"min,omitempty"`
	Max     *float64      `json:"max,omitempty"`
	Options []FieldOption `json:"options,omitempty"`
}
type FieldOption struct {
	Label        string `json:"label"`
	Value        string `json:"value"`
	Capabilities any    `json:"capabilities,omitempty"`
}
type Operation struct {
	UnavailableReason string      `json:"unavailableReason,omitempty"`
	ID                string      `json:"id"`
	Version           int         `json:"version"`
	Name              string      `json:"name"`
	OutputType        string      `json:"outputType"`
	Inputs            []InputPort `json:"inputs"`
	Fields            []Field     `json:"fields"`
}
type UpdateRequest struct {
	Name             string     `json:"name"`
	Description      string     `json:"description"`
	Definition       Definition `json:"definition"`
	ExpectedRevision int        `json:"expectedRevision"`
}
type Editor struct {
	Workflow   Template    `json:"workflow"`
	Operations []Operation `json:"operations"`
}

func Operations() []Operation {
	out := []Operation{}
	for _, kind := range []string{"image", "video", "audio", "text"} {
		out = append(out, Operation{ID: "generate." + kind, Version: 1, Name: "生成" + kind, OutputType: kind, Inputs: []InputPort{{"prompt", "提示词", "text", false, true}, {"referenceImages", "参考图片", "image", false, true}, {"referenceVideos", "参考视频", "video", false, true}, {"referenceAudios", "参考音频", "audio", false, true}}, Fields: []Field{{Key: "prompt", Label: "提示词", Type: "textarea"}, {Key: "size", Label: "尺寸", Type: "string"}, {Key: "quality", Label: "质量", Type: "string"}, {Key: "videoSeconds", Label: "时长", Type: "number"}, {Key: "seed", Label: "种子", Type: "number"}}})
	}
	out = append(out, Operation{ID: "video.depth", Version: 1, Name: "深度提取", OutputType: "video", Inputs: []InputPort{{"video", "视频", "video", true, false}}, Fields: []Field{}}, Operation{ID: "video.trim", Version: 1, Name: "视频裁剪", OutputType: "video", Inputs: []InputPort{{"video", "视频", "video", true, false}}, Fields: []Field{{Key: "startSeconds", Label: "开始秒数", Type: "number"}, {Key: "endSeconds", Label: "结束秒数", Type: "number"}}}, Operation{ID: "video.merge", Version: 1, Name: "视频拼接", OutputType: "video", Inputs: []InputPort{{"videos", "视频片段", "video", true, true}}, Fields: []Field{}})
	names := map[string]string{"generate.image": "生成图片", "generate.video": "生成视频", "generate.audio": "生成音频", "generate.text": "生成文本"}
	for id, name := range map[string]string{"video.depth": "深度动作捕捉", "video.trim": "视频剪辑", "video.merge": "合并选中视频"} {
		names[id] = name
	}
	for i := range out {
		if strings.HasPrefix(out[i].ID, "generate.") {
			out[i].Fields = append([]Field{{Key: "modelOption", Label: "模型", Type: "select"}}, out[i].Fields...)
			if out[i].ID == "generate.video" {
				out[i].Fields = append(out[i].Fields, Field{Key: "vquality", Label: "清晰度", Type: "select"})
			}
		}
		if name, ok := names[out[i].ID]; ok {
			out[i].Name = name
		}
	}
	return append(append(out, MediaOperations()...), ImageWorkflowOperations()...)
}
func OperationByID(id string) Operation {
	for _, op := range Operations() {
		if op.ID == id {
			return op
		}
	}
	return Operation{}
}
func ValidateOperation(n Node) error {
	op := OperationByID(n.OperationID)
	if op.ID == "" || n.OperationVersion != op.Version || n.MediaType != op.OutputType {
		return fmt.Errorf("节点 %s 的操作版本或输出类型无效", n.ID)
	}
	if strings.HasPrefix(op.ID, "generate.") && n.SourceTaskID == "" && (n.Config["modelOption"] == nil || strings.TrimSpace(fmt.Sprint(n.Config["modelOption"])) == "") {
		return fmt.Errorf("节点 %s 请选择生成模型", n.ID)
	}
	for key, value := range n.Config {
		found := false
		for _, f := range op.Fields {
			if f.Key == key {
				found = true
				if f.Type == "number" {
					number, ok := value.(float64)
					if !ok {
						if v, yes := value.(int); yes {
							number = float64(v)
							ok = true
						}
					}
					if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
						return fmt.Errorf("节点 %s 参数 %s 必须为数字", n.ID, key)
					}
				} else if _, ok := value.(string); !ok {
					return fmt.Errorf("节点 %s 参数 %s 必须为文本", n.ID, key)
				}
			}
		}
		if !found {
			return fmt.Errorf("节点 %s 不支持参数 %s", n.ID, key)
		}
	}
	if op.ID == "video.trim" {
		start := operationNumber(n.Config["startSeconds"])
		end := operationNumber(n.Config["endSeconds"])
		if start < 0 || end <= start {
			return fmt.Errorf("节点 %s 裁剪结束时间必须大于开始时间", n.ID)
		}
	}
	if strings.HasSuffix(op.ID, ".ai-upscale") {
		_, err := UpscaleRequest(n)
		return err
	}
	if op.ID == "image.describe" && strings.TrimSpace(fmt.Sprint(n.Config["modelOption"])) == "" {
		return fmt.Errorf("请选择支持识图的文本模型")
	}
	return ValidateMediaConfig(n)
}

func operationNumber(value any) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case int:
		return float64(number)
	}
	return 0
}
func ValidatePort(from, to Node, e Edge, edges []Edge) error {
	if e.FromPort != "output" || e.Order < 0 {
		return fmt.Errorf("节点 %s 的输出端口或顺序无效", from.ID)
	}
	for _, p := range OperationByID(to.OperationID).Inputs {
		if e.ToPort == p.ID {
			if from.MediaType != p.MediaType {
				return fmt.Errorf("节点 %s 端口 %s 素材类型不匹配", to.ID, p.ID)
			}
			for _, other := range edges {
				if other.To == e.To && other.ToPort == e.ToPort && other != e && (!p.Multiple || other.Order == e.Order) {
					return fmt.Errorf("节点 %s 端口 %s 的槽位重复", to.ID, p.ID)
				}
			}
			return nil
		}
	}
	return fmt.Errorf("节点 %s 的输入端口 %s 无效", to.ID, e.ToPort)
}

// Normalize annotates legacy definitions without touching their private recipes.
func Normalize(d Definition) Definition {
	nodes := map[string]Node{}
	for i, n := range d.Nodes {
		if n.Role == "generation" {
			n.Role = "operation"
			n.OperationID = "generate." + n.MediaType
			n.OperationVersion = 1
		}
		if n.Role == "depth" {
			n.Role = "operation"
			n.OperationID = "video.depth"
			n.OperationVersion = 1
		}
		d.Nodes[i] = n
		nodes[n.ID] = n
	}
	counters := map[string]int{}
	for i, e := range d.Edges {
		if e.FromPort == "" {
			e.FromPort = "output"
		}
		if e.ToPort == "" {
			if nodes[e.To].OperationID == "video.depth" {
				e.ToPort = "video"
			} else if nodes[e.From].MediaType == "text" {
				e.ToPort = "prompt"
			} else {
				e.ToPort = "reference" + strings.ToUpper(nodes[e.From].MediaType[:1]) + nodes[e.From].MediaType[1:] + "s"
			}
			key := e.To + ":" + e.ToPort
			e.Order = counters[key]
			counters[key]++
		}
		d.Edges[i] = e
	}
	return d
}
