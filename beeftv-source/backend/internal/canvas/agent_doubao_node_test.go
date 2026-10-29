package canvas

import (
	"encoding/json"
	"strings"
	"testing"
)

type doubaoTestDoc struct {
	Nodes []struct {
		ID       string         `json:"id"`
		Type     string         `json:"type"`
		Width    float64        `json:"width"`
		Metadata map[string]any `json:"metadata"`
	} `json:"nodes"`
}

func loadDoubaoTestDoc(t *testing.T, svc *Service, actor, canvasID string) doubaoTestDoc {
	t.Helper()
	raw, err := svc.UserCanvasProject(actor, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc doubaoTestDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// 外部 Agent 只能配置豆包账号节点（账号、模式、提示词、比例、时长、视频模型），
// 不能写运行状态和结果，也不能触发运行：生成始终由界面里的节点发起。
func TestAgentCanCreateAndConfigureDoubaoAccountNode(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	actor, canvasID := "owner", "canvas-doubao-node"
	base, err := svc.UpsertUserCanvasProject(actor, json.RawMessage(`{"id":"canvas-doubao-node","revision":0,"title":"豆包","nodes":[],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}

	summary, created, err := svc.CreateUserCanvasNodes(actor, canvasID, []NodeDraft{{Title: "豆包生视频", Type: "doubao-account", Prompt: "雨夜街头，镜头缓慢推进"}}, base.Revision)
	if err != nil {
		t.Fatalf("豆包节点应可由 Agent 创建: %v", err)
	}
	nodeID := created[0].ID
	doc := loadDoubaoTestDoc(t, svc, actor, canvasID)
	node := doc.Nodes[0]
	if node.Type != "doubao-account" || node.Width != 480 {
		t.Fatalf("节点类型/默认宽度不对: %+v", node)
	}
	state, _ := node.Metadata["doubaoAccountNode"].(map[string]any)
	if state["mode"] != "chat" || state["prompt"] != "雨夜街头，镜头缓慢推进" || state["status"] != "idle" || state["schemaVersion"] != float64(1) {
		t.Fatalf("初始状态不对: %#v", state)
	}
	if _, stray := node.Metadata["prompt"]; stray {
		t.Fatalf("提示词只应在 doubaoAccountNode 里，不应多写 metadata.prompt: %#v", node.Metadata)
	}

	summary, err = svc.UpdateUserCanvasNodeFields(actor, canvasID, nodeID, map[string]any{
		"prompt": "改写后的提示词", "mode": "video", "accountId": float64(2),
		"ratio": "16:9", "duration": float64(5), "videoModel": "Seedance 2.0 Mini",
	}, summary.Revision)
	if err != nil {
		t.Fatalf("配置豆包节点: %v", err)
	}
	state, _ = loadDoubaoTestDoc(t, svc, actor, canvasID).Nodes[0].Metadata["doubaoAccountNode"].(map[string]any)
	want := map[string]any{"prompt": "改写后的提示词", "mode": "video", "accountId": float64(2), "ratio": "16:9", "duration": float64(5), "videoModel": "Seedance 2.0 Mini", "status": "idle", "schemaVersion": float64(1)}
	for key, value := range want {
		if state[key] != value {
			t.Fatalf("字段 %s 应为 %v，实际 %v（整体 %#v）", key, value, state[key], state)
		}
	}
	if _, stray := loadDoubaoTestDoc(t, svc, actor, canvasID).Nodes[0].Metadata["prompt"]; stray {
		t.Fatalf("prompt 补丁不应写到 metadata.prompt")
	}

	// 运行状态、结果与任务 id 归界面所有，Agent 不能伪造。
	for _, forbidden := range []string{"status", "resultText", "resultPreviewUrl", "videoTaskId", "latestReply", "progress", "error"} {
		if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, nodeID, map[string]any{forbidden: "x"}, summary.Revision); err == nil {
			t.Fatalf("Agent 不应能写字段 %s", forbidden)
		}
	}
	// 模式只能是 chat / image / video。
	_, err = svc.UpdateUserCanvasNodeFields(actor, canvasID, nodeID, map[string]any{"mode": "audio"}, summary.Revision)
	if err == nil || !strings.Contains(err.Error(), "chat|image|video") {
		t.Fatalf("非法 mode 应被拒绝并说明可选值: %v", err)
	}
	// 数字字段必须是数字。
	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, nodeID, map[string]any{"accountId": "2"}, summary.Revision); err == nil {
		t.Fatalf("accountId 传字符串应被拒绝")
	}
}

func TestDoubaoAccountNodeConnectionRules(t *testing.T) {
	registry := canvasCapabilityRegistry
	if err := registry.ValidateReferenceConnection("text", "doubao-account"); err != nil {
		t.Fatalf("文本节点应能作为豆包节点的输入: %v", err)
	}
	if err := registry.ValidateReferenceConnection("image", "doubao-account"); err != nil {
		t.Fatalf("图片节点应能作为豆包节点的参考图: %v", err)
	}
	if err := registry.ValidateReferenceConnection("doubao-account", "image"); err != nil {
		t.Fatalf("豆包节点的文本结果应能交给图片节点: %v", err)
	}
	if err := registry.ValidateReferenceConnection("video", "doubao-account"); err == nil {
		t.Fatalf("视频节点不应作为豆包节点的输入")
	}
}
