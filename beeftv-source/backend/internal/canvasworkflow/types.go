package canvasworkflow

import (
	"fmt"
	"strings"
	"time"
)

type Node struct {
	ID                        string         `json:"id"`
	Title                     string         `json:"title"`
	MediaType                 string         `json:"mediaType"`
	Role                      string         `json:"role"`
	ResourceID                string         `json:"resourceId,omitempty"`
	UseDefault                bool           `json:"useDefault,omitempty"`
	Text                      string         `json:"text,omitempty"`
	SourceTaskID              string         `json:"sourceTaskId,omitempty"`
	OperationID               string         `json:"operationId,omitempty"`
	OperationVersion          int            `json:"operationVersion,omitempty"`
	Config                    map[string]any `json:"config,omitempty"`
	VideoDurationSourceNodeID string         `json:"videoDurationSourceNodeId,omitempty"`
}
type Edge struct {
	From     string `json:"fromNodeId"`
	To       string `json:"toNodeId"`
	FromPort string `json:"fromPort,omitempty"`
	ToPort   string `json:"toPort,omitempty"`
	Order    int    `json:"order,omitempty"`
}
type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Definition struct {
	Version             int                 `json:"version"`
	Nodes               []Node              `json:"nodes"`
	Edges               []Edge              `json:"edges"`
	OutputNodeIDs       []string            `json:"outputNodeIds"`
	Positions           map[string]Position `json:"positions,omitempty"`
	EditorLayoutVersion int                 `json:"editorLayoutVersion,omitempty"`
	PresentationVersion int                 `json:"presentationVersion,omitempty"`
}
type Template struct {
	ID          string     `json:"id"`
	Revision    int        `json:"revision"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Definition  Definition `json:"definition"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}
type CreateRequest struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Definition  Definition `json:"definition"`
}
type Value struct {
	ResourceID string `json:"resourceId,omitempty"`
	Text       string `json:"text,omitempty"`
}
type RunRequest struct {
	TemplateRevision  int              `json:"templateRevision"`
	ClientOperationID string           `json:"clientOperationId"`
	Inputs            map[string]Value `json:"inputs"`
}
type Step struct {
	NodeID     string  `json:"nodeId"`
	Title      string  `json:"title"`
	Status     string  `json:"status"`
	TaskID     string  `json:"taskId,omitempty"`
	Error      string  `json:"error,omitempty"`
	ResourceID string  `json:"resourceId,omitempty"`
	Text       string  `json:"text,omitempty"`
	Candidates []Value `json:"candidates,omitempty"`
}
type Output struct {
	NodeID     string `json:"nodeId"`
	MediaType  string `json:"mediaType"`
	ResourceID string `json:"resourceId,omitempty"`
	Text       string `json:"text,omitempty"`
}
type Run struct {
	TemplateRevision int       `json:"templateRevision"`
	ID               string    `json:"id"`
	TemplateID       string    `json:"templateId"`
	TemplateName     string    `json:"templateName"`
	Status           string    `json:"status"`
	Error            string    `json:"error,omitempty"`
	Steps            []Step    `json:"steps"`
	Outputs          []Output  `json:"outputs"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// Validate returns dependency order and rejects graphs whose inputs cannot be used.
func Validate(d Definition) ([]Node, error) {
	if d.Version != 1 || len(d.Nodes) == 0 || len(d.Nodes) > 100 || len(d.Edges) > 500 {
		return nil, fmt.Errorf("工作流需要 1–100 个节点，且必须使用版本 1")
	}
	nodes := map[string]Node{}
	incoming := map[string]int{}
	outgoing := map[string][]string{}
	execution := 0
	for _, n := range d.Nodes {
		if n.Role != "operation" && len(n.Config) > 0 {
			return nil, fmt.Errorf("节点 %s 不支持操作参数", n.ID)
		}
		if strings.TrimSpace(n.Title) == "" {
			return nil, fmt.Errorf("节点 %s 名称不能为空", n.ID)
		}
		if n.Role == "constant" && n.MediaType == "text" && strings.TrimSpace(n.Text) == "" {
			return nil, fmt.Errorf("固定文本节点 %s 内容不能为空", n.ID)
		}
		if strings.TrimSpace(n.ID) == "" || len(n.ID) > 128 {
			return nil, fmt.Errorf("节点 ID 无效")
		}
		if _, ok := nodes[n.ID]; ok {
			return nil, fmt.Errorf("节点 ID 重复：%s", n.ID)
		}
		if n.MediaType != "image" && n.MediaType != "video" && n.MediaType != "audio" && n.MediaType != "text" {
			return nil, fmt.Errorf("节点 %s 的素材类型不支持", n.Title)
		}
		switch n.Role {
		case "input", "constant":
		case "generation":
			execution++
			if n.SourceTaskID == "" {
				return nil, fmt.Errorf("节点 %s 缺少已成功执行的原任务，请先手动生成一次", n.Title)
			}
		case "depth":
			execution++
			if n.MediaType != "video" {
				return nil, fmt.Errorf("深度步骤必须输出视频")
			}
		case "operation":
			execution++
			if err := ValidateOperation(n); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("节点 %s 的角色不支持", n.Title)
		}
		nodes[n.ID] = n
	}
	if execution == 0 {
		return nil, fmt.Errorf("工作流至少需要一个生成或深度处理步骤")
	}
	seen := map[Edge]bool{}
	for _, e := range d.Edges {
		from, ok := nodes[e.From]
		to, ok2 := nodes[e.To]
		if !ok || !ok2 || e.From == e.To || seen[e] {
			return nil, fmt.Errorf("工作流连线重复或引用了缺失节点")
		}
		if to.Role != "generation" && to.Role != "depth" && to.Role != "operation" {
			return nil, fmt.Errorf("%s 的连线目标必须是执行步骤", from.Title)
		}
		seen[e] = true
		if to.Role == "operation" {
			if err := ValidatePort(from, to, e, d.Edges); err != nil {
				return nil, err
			}
		}
		incoming[e.To]++
		outgoing[e.From] = append(outgoing[e.From], e.To)
	}
	outputs := map[string]bool{}
	for _, id := range d.OutputNodeIDs {
		if _, ok := nodes[id]; !ok || outputs[id] {
			return nil, fmt.Errorf("工作流输出节点无效")
		}
		outputs[id] = true
	}
	if len(outputs) == 0 {
		return nil, fmt.Errorf("请选择至少一个输出节点")
	}
	for _, n := range d.Nodes {
		if n.VideoDurationSourceNodeID != "" {
			source, exists := nodes[n.VideoDurationSourceNodeID]
			connected := false
			for _, edge := range d.Edges {
				if edge.From == source.ID && edge.To == n.ID && (edge.ToPort == "referenceVideos" || edge.ToPort == "") {
					connected = true
				}
			}
			if n.MediaType != "video" || (n.Role != "generation" && n.OperationID != "generate.video") || !exists || source.MediaType != "video" || !connected {
				return nil, fmt.Errorf("节点 %s 的时长必须跟随已连接的参考视频", n.Title)
			}
		}
		if n.Role == "input" && len(outgoing[n.ID]) == 0 {
			return nil, fmt.Errorf("可替换输入 %s 未连接执行步骤", n.Title)
		}
		if n.Role == "depth" && incoming[n.ID] != 1 {
			return nil, fmt.Errorf("深度步骤 %s 必须连接一个视频输入", n.Title)
		}
		if n.Role == "operation" {
			if n.OperationID == "video.merge" && incoming[n.ID] < 2 {
				return nil, fmt.Errorf("节点 %s 的 videos 端口至少需要两个片段", n.ID)
			}
			for _, port := range OperationByID(n.OperationID).Inputs {
				if port.Required {
					count := 0
					for _, edge := range d.Edges {
						if edge.To == n.ID && edge.ToPort == port.ID {
							count++
						}
					}
					if count == 0 {
						return nil, fmt.Errorf("节点 %s 缺少端口 %s", n.ID, port.ID)
					}
				}
			}
		}
	}
	queue := []string{}
	for _, n := range d.Nodes {
		if incoming[n.ID] == 0 {
			queue = append(queue, n.ID)
		}
	}
	order := []Node{}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		order = append(order, nodes[id])
		for _, next := range outgoing[id] {
			incoming[next]--
			if incoming[next] == 0 {
				queue = append(queue, next)
			}
		}
	}
	if len(order) != len(nodes) {
		return nil, fmt.Errorf("工作流包含循环，请移除循环连线")
	}
	return order, nil
}
