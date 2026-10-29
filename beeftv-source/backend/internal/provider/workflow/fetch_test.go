package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestFetchSettingsAllowsEmptyPrompt(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if !strings.Contains(req.URL, "/api/openapi/getJsonApiFormat") {
			t.Fatalf("unexpected URL %s", req.URL)
		}
		if req.Kind != "" {
			t.Fatalf("settings fetch kind = %q, want empty", req.Kind)
		}
		return []byte(`{"code":1,"msg":"ignored","data":{"prompt":""}}`), "application/json", nil
	}}
	client := &Client{Requests: exec}
	result, err := client.FetchSettingsWorkflow(context.Background(), Config{APIKey: "k", BaseURL: "https://www.runninghub.cn"}, FetchRequest{
		WorkflowID: "wf-1",
		Title:      "Demo",
		Capability: "image",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["kind"] != "workflow" || result["workflowId"] != "wf-1" || result["title"] != "Demo" {
		t.Fatalf("result = %#v", result)
	}
	workflowJSON, _ := result["workflowJson"].(map[string]any)
	if workflowJSON == nil {
		t.Fatal("empty prompt must still return a workflowJson object")
	}
	if len(workflowJSON) != 0 {
		t.Fatalf("workflowJson = %#v, want empty", workflowJSON)
	}
	fields, _ := result["fields"].([]map[string]any)
	if len(fields) != 0 {
		t.Fatalf("fields = %#v, want empty", fields)
	}
}

func TestFetchSettingsParsesStringPrompt(t *testing.T) {
	prompt := `{"3":{"class_type":"CLIPTextEncode","inputs":{"text":"hi"}}}`
	body, _ := json.Marshal(map[string]any{"data": map[string]any{"prompt": prompt}})
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		return body, "application/json", nil
	}}
	result, err := (&Client{Requests: exec}).FetchSettingsWorkflow(context.Background(), Config{APIKey: "k"}, FetchRequest{WorkflowID: "wf-1", Capability: "image"})
	if err != nil {
		t.Fatal(err)
	}
	fields, _ := result["fields"].([]map[string]any)
	if len(fields) == 0 {
		t.Fatalf("expected inferred fields, got %#v", result["fields"])
	}
}

func TestFetchSettingsRejectsInvalidPromptJSON(t *testing.T) {
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		return []byte(`{"data":{"prompt":"{not-json"}}`), "application/json", nil
	}}
	_, err := (&Client{Requests: exec}).FetchSettingsWorkflow(context.Background(), Config{APIKey: "k"}, FetchRequest{WorkflowID: "wf-1"})
	if err == nil || !strings.Contains(err.Error(), "工作流 JSON 解析失败") {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchWorkflowJSONRequiresPrompt(t *testing.T) {
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		return []byte(`{"code":0,"data":{}}`), "application/json", nil
	}}
	_, err := (&Client{Requests: exec}).FetchWorkflowJSON(context.Background(), "https://www.runninghub.cn", Config{APIKey: "k"}, "wf-1")
	if err == nil || !strings.Contains(err.Error(), "缺少 prompt") {
		t.Fatalf("error = %v, want missing prompt", err)
	}
}
