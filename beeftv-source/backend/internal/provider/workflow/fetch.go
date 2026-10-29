package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// FetchSettingsWorkflow loads settings-page workflow JSON. Empty prompt is a
// valid empty schema, not a parse error. Payload code is not treated as failure.
func (c *Client) FetchSettingsWorkflow(ctx context.Context, config Config, req FetchRequest) (map[string]any, error) {
	exec := c.prepared()
	if exec.Requests == nil {
		return nil, errors.New("工作流缺少受保护的请求执行端口")
	}
	workflowID := strings.TrimSpace(req.WorkflowID)
	if workflowID == "" {
		return nil, errors.New("workflowId 不能为空")
	}
	root := runningHubRootURL(config.BaseURL)
	response, err := exec.PostJSON(ctx, config, root+"/api/openapi/getJsonApiFormat", "", map[string]any{
		"apiKey":     runningHubAPIKey(config),
		"workflowId": workflowID,
	})
	if err != nil {
		return nil, fmt.Errorf("拉取 RunningHub 工作流参数失败：%w", err)
	}
	data, _ := response["data"].(map[string]any)
	if data == nil {
		return nil, errors.New("RunningHub 工作流参数响应缺少 data")
	}
	workflowJSON, err := parseWorkflowPrompt(data["prompt"], false)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"workflowId":   workflowID,
		"kind":         "workflow",
		"title":        firstNonEmpty(req.Title, workflowID),
		"fields":       CollectFields(workflowJSON, req.Capability),
		"workflowJson": workflowJSON,
		"raw":          response,
	}, nil
}

func parseWorkflowPrompt(raw any, required bool) (map[string]any, error) {
	if required {
		if raw == nil {
			return nil, errors.New("RunningHub 工作流参数响应缺少 prompt")
		}
		if text, ok := raw.(string); ok {
			var parsed map[string]interface{}
			if err := json.Unmarshal([]byte(text), &parsed); err != nil {
				return nil, err
			}
			return parsed, nil
		}
		parsed, ok := raw.(map[string]interface{})
		if !ok {
			return nil, errors.New("RunningHub 工作流参数格式无效")
		}
		return parsed, nil
	}
	workflowJSON := map[string]any{}
	if prompt, ok := raw.(string); ok && strings.TrimSpace(prompt) != "" {
		if err := json.Unmarshal([]byte(prompt), &workflowJSON); err != nil {
			return nil, fmt.Errorf("RunningHub 工作流 JSON 解析失败：%w", err)
		}
	} else if prompt, ok := raw.(map[string]any); ok {
		workflowJSON = prompt
	}
	return workflowJSON, nil
}
