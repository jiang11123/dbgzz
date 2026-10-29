package app

import (
	"fmt"
	"regexp"

	cw "infinite-canvas/backend/internal/canvasworkflow"
)

var workflowNodeMentionPattern = regexp.MustCompile(`@\[node:([^\]\s]+)\]`)

func workflowNodeMentionToken(id string) string { return "@[node:" + id + "]" }

func workflowPromptBinding(field string) bool { return field == "prompt" || field == "promptMention" }

// Names are presentation only. Bind stable node identities to the provider's
// actual reference slots, without exposing that numbering in the editor.
func workflowNodePromptBindings(prompt string, bindings []workflowBinding, nodes map[string]cw.Node, edges []cw.Edge, target string) ([]workflowBinding, error) {
	var mentions []workflowBinding
	for _, match := range workflowNodeMentionPattern.FindAllStringSubmatchIndex(prompt, -1) {
		id := prompt[match[2]:match[3]]
		node, exists := nodes[id]
		connected := false
		for _, edge := range edges {
			if edge.From == id && edge.To == target {
				connected = true
				break
			}
		}
		if !exists || !connected {
			return nil, workflowBad("提示词引用的工作流节点已断开或删除，请重新选择")
		}
		binding := workflowBinding{NodeID: id, Field: "prompt", Index: match[0], Original: prompt[match[0]:match[1]]}
		if node.MediaType != "text" {
			index := -1
			for _, media := range bindings {
				if media.NodeID != id || media.Field != workflowMediaField(node.MediaType) {
					continue
				}
				if index >= 0 && index != media.Index {
					return nil, workflowBad("节点 " + node.Title + " 对应多个参考位置，请保留一条引用连线")
				}
				index = media.Index
			}
			if index < 0 {
				return nil, workflowBad("节点 " + node.Title + " 未建立有效的素材引用")
			}
			binding.Field = "promptMention"
			binding.ReferenceLabel = fmt.Sprintf("@%s%d", map[string]string{"image": "图片", "video": "视频", "audio": "音频"}[node.MediaType], index+1)
		}
		mentions = append(mentions, binding)
	}
	return mentions, nil
}
