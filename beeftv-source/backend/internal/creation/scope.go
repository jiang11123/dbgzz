package creation

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func ValidateSubmissionScope(run *model.CreationRun, version int64, req TaskRequest) error {
	if run.Status == "paused" || run.Status == "cancelled" || run.Status == "completed" {
		return Conflict("请先恢复创作任务")
	}
	if req.Type == "canvas_text" || req.Type == "text" {
		if req.ProjectID != "" && req.ProjectID != run.CanvasID {
			return Conflict("规划任务的画布关联不匹配")
		}
		return nil
	}
	if run.CanvasID == "" || req.ProjectID != run.CanvasID {
		return Conflict("媒体任务必须提交到当前创作画布")
	}
	if run.ApprovedAt == nil || version != run.ApprovedProposalVersion || run.ApprovedProposalHash == "" {
		return Conflict("请先确认当前方案")
	}
	var ops []CanvasOp
	_ = json.Unmarshal([]byte(run.ApprovedOperationsJSON), &ops)
	nodeID := stringValue(req.Input["nodeId"])
	metadata, _ := req.Input["metadata"].(map[string]any)
	if nodeID == "" {
		nodeID = stringValue(metadata["nodeId"])
	}
	for _, op := range ops {
		if op.ID != nodeID || nodeID == "" {
			continue
		}
		if op.Type != "add_node" && op.Type != "update_node" {
			continue
		}
		meta := op.Metadata
		if nested, ok := op.Patch["metadata"].(map[string]any); ok {
			meta = MergeMaps(nested, meta)
		}
		prompt := stringValue(meta["prompt"])
		if prompt == "" {
			prompt = stringValue(meta["text"])
		}
		if strings.TrimSpace(req.Prompt) != strings.TrimSpace(prompt) || prompt == "" {
			return Conflict("任务提示词已超出获批方案")
		}
		if stringValue(meta["model"]) == "" || stringValue(meta["model"]) != req.Model {
			return Conflict("模型与已批准方案不同")
		}
		config, _ := req.Input["config"].(map[string]any)
		for _, key := range []string{"size", "videoSeconds", "vquality", "quality"} {
			metadataKey := key
			if key == "videoSeconds" {
				metadataKey = "seconds"
			}
			approved := strings.TrimSpace(stringValue(meta[metadataKey]))
			candidate := strings.TrimSpace(stringValue(config[key]))
			if metadataKey == "quality" {
				approvedNorm := strings.ToLower(approved)
				candidateNorm := strings.ToLower(candidate)
				if (approvedNorm == "auto" || approvedNorm == "any" || approvedNorm == "") && (candidateNorm == "auto" || candidateNorm == "any" || candidateNorm == "") {
					continue
				}
				if approvedNorm == candidateNorm {
					continue
				}
			}
			if approved != "" && approved != candidate {
				return Conflict("生成规格与已批准方案不同")
			}
		}
		refs, _ := meta["referenceNodeIds"].([]any)
		images, _ := req.Input["referenceImages"].([]any)
		if len(refs) != len(images) {
			return Conflict("参考素材数量与已批准方案不同")
		}
		for index, ref := range refs {
			image, _ := images[index].(map[string]any)
			if stringValue(ref) != stringValue(image["id"]) {
				return Conflict("参考素材与已批准方案不同")
			}
		}
		for _, kind := range []string{"referenceVideos", "referenceAudios"} {
			if values, ok := req.Input[kind].([]any); ok && len(values) > 0 {
				return Conflict("本期方案尚未授权视频或音频参考输入")
			}
		}
		return nil
	}
	return Conflict("任务节点不在已批准方案范围内")
}
