package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/kernel"
)

// 画布编辑器的提示词输入框读的是 metadata.composerContent（见
// canvas-node-prompt-panel.tsx：composerContent ?? prompt）。因此外部写入必须落到
// 描述符声明的同一路径，否则「外部改提示词」在界面上看不到，还会把生成节点的
// 媒体结果槽位 metadata.content 覆盖掉。
func TestUpdateUserCanvasNodeFieldsFollowsDescriptorPaths(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	actor := "owner"
	canvasID := "canvas-patch-paths"
	created, err := svc.UpsertUserCanvasProject(actor, json.RawMessage(`{
		"id":"canvas-patch-paths","revision":0,"title":"补丁路径",
		"nodes":[
			{"id":"img","type":"image","title":"镜头","metadata":{"content":"","prompt":"已提交提示词","composerContent":"原始草稿","status":"idle"}},
			{"id":"txt","type":"text","title":"文本","metadata":{"content":"正文","status":"idle"}}
		],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, "img", map[string]any{"content": "夜景：雨夜巷口对峙"}, created.Revision); err != nil {
		t.Fatal(err)
	}
	raw, err := svc.UserCanvasProject(actor, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	image := doc.Nodes[0]
	if image.Metadata["composerContent"] != "夜景：雨夜巷口对峙" {
		t.Fatalf("生成节点 content 补丁应落到 composerContent，实际 %#v", image.Metadata)
	}
	if image.Metadata["prompt"] != "已提交提示词" {
		t.Fatalf("content 补丁不得改写已提交提示词，实际 %#v", image.Metadata["prompt"])
	}
	if image.Metadata["content"] != "" {
		t.Fatalf("content 补丁不得覆盖媒体结果槽位，实际 %#v", image.Metadata["content"])
	}

	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, "txt", map[string]any{"content": "新的正文"}, created.Revision+1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, "img", map[string]any{"prompt": "重新提交的提示词"}, created.Revision+2); err != nil {
		t.Fatal(err)
	}
	raw, err = svc.UserCanvasProject(actor, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Nodes[1].Metadata["content"] != "新的正文" {
		t.Fatalf("文本节点 content 补丁应落到 content，实际 %#v", doc.Nodes[1].Metadata)
	}
	if doc.Nodes[0].Metadata["prompt"] != "重新提交的提示词" {
		t.Fatalf("prompt 补丁应仍写入 metadata.prompt，实际 %#v", doc.Nodes[0].Metadata["prompt"])
	}
	if doc.Nodes[0].Metadata["composerContent"] != "夜景：雨夜巷口对峙" {
		t.Fatalf("prompt 补丁不得改写编辑器草稿，实际 %#v", doc.Nodes[0].Metadata["composerContent"])
	}
}

// script/frame 这类结构节点没有 PatchFields，但「名称可编辑」是既有体验：
// title 必须走通用节点字段写入，不能出现「返回成功但没改」。
func TestUpdateUserCanvasNodeFieldsKeepsTitleEditableForStructureNodes(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas-structure","revision":0,"title":"结构节点",
		"nodes":[
			{"id":"scr","type":"script","title":"旧脚本名","metadata":{"storyboard":{"rows":[]}}},
			{"id":"frm","type":"frame","title":"旧背板名","metadata":{"frame":{"collapsed":false}}}
		],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	for index, nodeID := range []string{"scr", "frm"} {
		if _, err := svc.UpdateUserCanvasNodeFields("owner", "canvas-structure", nodeID, map[string]any{"title": "新名字"}, created.Revision+int64(index)); err != nil {
			t.Fatalf("%s 改名应成功，实际 %v", nodeID, err)
		}
	}
	raw, _ := svc.UserCanvasProject("owner", "canvas-structure")
	var doc struct {
		Nodes []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Nodes[0].Title != "新名字" || doc.Nodes[1].Title != "新名字" {
		t.Fatalf("结构节点改名未生效: %#v", doc.Nodes)
	}
}

// 描述符没有声明的字段必须明确拒绝，且整批不写：revision 不推进、不产生幂等记录。
func TestUpdateUserCanvasNodeFieldsRejectsUnsupportedFieldWithoutWriting(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas-unsupported","revision":0,"title":"未支持字段",
		"nodes":[{"id":"scr","type":"script","title":"脚本","metadata":{"storyboard":{"rows":[]}}}],
		"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.UpdateUserCanvasNodeFields("owner", "canvas-unsupported", "scr", map[string]any{"content": "不该写入"}, created.Revision)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("script 的 content 应被明确拒绝，实际 %v", err)
	}
	if appError.Reason != kernel.ReasonUnsupportedField {
		t.Fatalf("reason 应为 unsupported_field，实际 %q", appError.Reason)
	}

	// 混入合法 title 也必须整批不写：不能出现「一半生效」。
	if _, err = svc.UpdateUserCanvasNodeFields("owner", "canvas-unsupported", "scr", map[string]any{"title": "新名", "content": "不该写入"}, created.Revision); err == nil {
		t.Fatal("含未支持字段的整批更新应被拒绝")
	}
	after, err := svc.UserCanvasProject("owner", "canvas-unsupported")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Revision int64 `json:"revision"`
		Nodes    []struct {
			Title    string         `json:"title"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(after, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Revision != created.Revision {
		t.Fatalf("被拒绝的更新不应推进 revision：%d -> %d", created.Revision, doc.Revision)
	}
	if doc.Nodes[0].Title != "脚本" {
		t.Fatalf("被拒绝的更新不应写入 title，实际 %q", doc.Nodes[0].Title)
	}
}

// 历史节点可能没有 metadata：ApplyPatch 的落点必须先绑定到节点上，不能被空 map 覆盖。
func TestUpdateUserCanvasNodeFieldsPreservesPatchOnNodeWithoutMetadata(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas-no-metadata","revision":0,"title":"无 metadata",
		"nodes":[{"id":"txt","type":"text","title":"旧文本"}],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateUserCanvasNodeFields("owner", "canvas-no-metadata", "txt", map[string]any{"content": "第一次写入"}, created.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateUserCanvasNodeFields("owner", "canvas-no-metadata", "txt", map[string]any{"content": "第二次写入"}, created.Revision+1); err != nil {
		t.Fatal(err)
	}
	raw, err := svc.UserCanvasProject("owner", "canvas-no-metadata")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Nodes[0].Metadata["content"] != "第二次写入" {
		t.Fatalf("无 metadata 节点的内容更新被丢弃: %#v", doc.Nodes[0].Metadata)
	}
}
