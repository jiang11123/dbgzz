package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Capture before completion compacts InputJSON. The snapshot and successful
// result commit atomically on the task row, and disappear with the task.
func (s *Service) captureCanvasWorkflowSource(task model.Task) (string, error) {
	if task.WorkflowSourceCipher != "" {
		return task.WorkflowSourceCipher, nil
	}
	if task.Type != "canvas_image" && task.Type != "canvas_video" && task.Type != "canvas_audio" && task.Type != "canvas_text" && !strings.HasPrefix(task.Type, "video_") {
		return "", nil
	}
	var input map[string]any
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input == nil {
		return "", nil
	}
	if _, ok := input["config"].(map[string]any); !ok {
		return "", nil
	}
	// The canonical input already protects credentials. Encrypt the entire
	// command as well so private prompts and reference identities stay private.
	return s.encryptSettingSecret(task.InputJSON)
}

func (s *Service) canvasWorkflowSourceInput(task *model.Task) (map[string]any, error) {
	raw := task.InputJSON
	if task.WorkflowSourceCipher != "" {
		var err error
		raw, err = s.decryptSettingSecret(task.WorkflowSourceCipher)
		if err != nil {
			return nil, workflowBad("无法解密原工作流配方，请先恢复工作区密钥或重新手动运行节点")
		}
	}
	plain, err := s.decryptTaskInputJSON(raw)
	if err != nil {
		return nil, workflowBad("无法读取原任务配方，请重新手动运行该节点")
	}
	var input map[string]any
	if json.Unmarshal([]byte(plain), &input) != nil || input == nil {
		return nil, workflowBad("原任务配方格式无效")
	}
	if _, ok := input["config"].(map[string]any); !ok {
		return nil, workflowBad("此历史任务的完整配方已清理，请先手动重新运行该生成节点，再将成功流程保存为工作流")
	}
	return input, nil
}
