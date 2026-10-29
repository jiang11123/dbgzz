package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"infinite-canvas/backend/internal/operations"
)

// TestMCPClientLoop 用官方 MCP 客户端连接 `beeftv mcp serve`，验证握手、工具描述、
// 幂等 operationId、冲突错误、只读工具与断开。
func TestMCPClientLoop(t *testing.T) {
	bin := os.Getenv("BEEFTV_BIN")
	if bin == "" {
		t.Skip("BEEFTV_BIN 未设置，跳过 MCP 客户端验收")
	}
	base := strings.TrimRight(os.Getenv("BEEFTV_BASE_URL"), "/")
	if base == "" {
		t.Fatal("BEEFTV_BASE_URL 未设置")
	}
	caseTag := fmt.Sprintf("%d", time.Now().UnixNano())
	canvasID := "mcp-canvas-" + caseTag
	// 幂等键必须每个 case 唯一：同一测试库重复跑时，不同 canvas 的 payload 不能复用同一个 operationId。
	operationID := "mcp-op-" + caseTag
	if err := seedCanvas(base, canvasID); err != nil {
		t.Fatalf("seed canvas: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "beeftv-acceptance-client", Version: "1.0.0"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: exec.Command(bin, "mcp", "serve")}, nil)
	if err != nil {
		t.Fatalf("MCP 握手失败: %v", err)
	}
	defer session.Close()
	if session.InitializeResult() == nil {
		t.Fatal("缺少 initialize 结果")
	}
	t.Logf("握手成功: %s %s", session.InitializeResult().ServerInfo.Name, session.InitializeResult().ServerInfo.Version)

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("tools/list 失败: %v", err)
	}
	registry := operations.NewRegistry(nil, nil)
	operations.RegisterDefaultOps(registry)
	expected := registry.List(operations.ManualCaller(false))
	apiClient, clientErr := newClient()
	if clientErr != nil {
		t.Fatal(clientErr)
	}
	business, discoveryErr := apiClient.businessTools(ctx)
	if discoveryErr != nil {
		t.Fatal(discoveryErr)
	}
	if len(tools.Tools) != len(expected)+len(business) {
		t.Fatalf("MCP tools = %d, workspace operations = %d, business handlers = %d", len(tools.Tools), len(expected), len(business))
	}
	for _, operation := range expected {
		found := false
		for _, tool := range tools.Tools {
			if tool.Name == operation.ID {
				found = true
				if tool.Annotations == nil || tool.Annotations.ReadOnlyHint != operation.ReadOnly {
					t.Fatalf("MCP permission differs from workspace operation %s", operation.ID)
				}
			}
		}
		if !found {
			t.Fatalf("MCP omitted workspace operation %s", operation.ID)
		}
	}
	var create *mcp.Tool
	var sawPropose bool
	for _, tool := range tools.Tools {
		if tool.Name == "canvas.generation.propose" {
			sawPropose = true
			if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
				t.Fatal("generation propose must advertise readOnlyHint")
			}
		}
		if tool.Name == "canvas.get" && (tool.Annotations == nil || !tool.Annotations.ReadOnlyHint) {
			t.Fatal("read-only canvas.get must advertise readOnlyHint")
		}
		if tool.Name == "canvas.nodes.create" {
			if tool.Annotations != nil && tool.Annotations.ReadOnlyHint {
				t.Fatal("write tool advertised read-only")
			}
			create = tool
		}
	}
	if create == nil || !sawPropose {
		t.Fatal("缺少 canvas.nodes.create 或 canvas.generation.propose")
	}
	schema, _ := json.Marshal(create.InputSchema)
	if !bytes.Contains(schema, []byte("operationId")) {
		t.Fatalf("写工具 schema 未暴露稳定 operationId: %s", string(schema))
	}
	// 只出现在 properties 里不够：必须标成必填，MCP 客户端才知道非发不可。
	var declared struct {
		Properties map[string]any `json:"properties"`
		Required   []string       `json:"required"`
	}
	if err := json.Unmarshal(schema, &declared); err != nil {
		t.Fatalf("写工具 schema 不是合法 JSON Schema: %v", err)
	}
	if _, ok := declared.Properties["operationId"]; !ok {
		t.Fatalf("写工具 schema 的 properties 缺少 operationId: %s", string(schema))
	}
	requiresOperationID := false
	for _, name := range declared.Required {
		if name == "operationId" {
			requiresOperationID = true
		}
	}
	if !requiresOperationID {
		t.Fatalf("写工具 schema 未把 operationId 标为必填: %s", string(schema))
	}

	// 1) 写工具缺 operationId：必须结构化失败，而不是随机补一个键
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas.nodes.create",
		Arguments: map[string]any{"canvasId": canvasID, "expectedRevision": 1,
			"nodes": []any{map[string]any{"title": "A", "type": "image"}}}})
	if err != nil {
		t.Fatalf("CallTool 传输层错误: %v", err)
	}
	if !result.IsError || !toolTextContains(result, "missing_operation_id") {
		t.Fatalf("缺 operationId 未返回结构化错误: %+v", result)
	}

	// 2) 同 operationId 同参数：第二次必须回读原结果
	args := map[string]any{"canvasId": canvasID, "expectedRevision": 1,
		"nodes": []any{map[string]any{"title": "A", "type": "image"}}, "operationId": operationID}
	first, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas.nodes.create", Arguments: args})
	if err != nil || first.IsError {
		t.Fatalf("首次写失败: err=%v result=%+v", err, first)
	}
	second, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas.nodes.create", Arguments: args})
	if err != nil || second.IsError {
		t.Fatalf("重试写失败: err=%v result=%+v", err, second)
	}
	if !toolTextContains(second, `"replayed":true`) {
		t.Fatalf("同 operationId 重试未回读原结果: %s", toolText(second))
	}

	// 3) 同 operationId 不同参数：必须冲突
	conflict, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas.nodes.create",
		Arguments: map[string]any{"canvasId": canvasID, "expectedRevision": 1,
			"nodes": []any{map[string]any{"title": "B", "type": "image"}}, "operationId": operationID}})
	if err != nil {
		t.Fatalf("冲突调用传输层错误: %v", err)
	}
	if !conflict.IsError || !toolTextContains(conflict, "operation_id_reused") {
		t.Fatalf("同 id 不同参数未报冲突: %s", toolText(conflict))
	}

	// 4) 只读工具：不需要 operationId
	read, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas.get", Arguments: map[string]any{"canvasId": canvasID}})
	if err != nil || read.IsError {
		t.Fatalf("只读工具失败: err=%v result=%+v", err, read)
	}
	if !toolTextContains(read, canvasID) {
		t.Fatalf("只读工具未返回画布内容: %s", toolText(read))
	}
	if err := session.Close(); err != nil {
		t.Fatalf("关闭会话失败: %v", err)
	}
	t.Log("MCP 客户端验收完成：握手/工具 schema/幂等/冲突/只读/断开")
}

func toolText(result *mcp.CallToolResult) string {
	var builder strings.Builder
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			builder.WriteString(text.Text)
		}
	}
	return builder.String()
}

func toolTextContains(result *mcp.CallToolResult, needle string) bool {
	return strings.Contains(toolText(result), needle)
}

func seedCanvas(base, canvasID string) error {
	body, err := json.Marshal(map[string]any{"project": map[string]any{
		"id": canvasID, "title": "MCP 验收画布", "revision": 0, "nodes": []any{}, "connections": []any{}}})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPut, base+"/canvas-projects/"+canvasID, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if owner := strings.TrimSpace(os.Getenv("BEEFTV_OWNER_TOKEN")); owner != "" {
		req.Header.Set("X-Beeftv-Owner", owner)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("seed 状态码 %d", resp.StatusCode)
	}
	return nil
}
