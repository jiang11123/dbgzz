package agentops_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/workspace"
)

// 付费生成只提议不执行：这个操作必须是只读的（不碰画布、不扣费），
// 并且只接受确实属于本画布的节点，否则模型可以借它把别处的对象写进提议。
func writeGenerationModels(t *testing.T, dataDir string) {
	t.Helper()
	body := `{"schemaVersion":1,"revision":1,"config":{"imageModel":"beefapi::gpt-image-2","videoModel":"beefapi::wan3.0-video","channels":[{"id":"beefapi","name":"BeefAPI","enabled":true,"models":["gpt-image-2","gpt-image-2.5-flare","wan3.0-video"],"modelProfiles":[{"model":"gpt-image-2","capability":"image","protocol":"openai-image"},{"model":"gpt-image-2.5-flare","capability":"image","protocol":"openai-image"},{"model":"wan3.0-video","capability":"video","protocol":"newapi-channel-1"}]}]}}`
	if err := os.WriteFile(filepath.Join(dataDir, "local-model-config.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) patchNode(t *testing.T, nodeID string, mutate func(node map[string]any)) {
	t.Helper()
	raw, err := h.service.UserCanvasProject(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	nodes, _ := doc["nodes"].([]any)
	found := false
	for index, rawNode := range nodes {
		node, _ := rawNode.(map[string]any)
		if node["id"] == nodeID {
			mutate(node)
			nodes[index] = node
			found = true
		}
	}
	if !found {
		t.Fatalf("missing node %s", nodeID)
	}
	doc["nodes"] = nodes
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.UpsertUserCanvasProject(h.userID, encoded); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) setNodeModel(t *testing.T, nodeID, model string) {
	t.Helper()
	h.patchNode(t, nodeID, func(node map[string]any) {
		metadata, _ := node["metadata"].(map[string]any)
		if metadata == nil {
			metadata = map[string]any{}
		}
		if model == "" {
			delete(metadata, "model")
		} else {
			metadata["model"] = model
		}
		node["metadata"] = metadata
	})
}

func TestGenerationProposeIsReadOnlyAndReportsCanvasDefaultModel(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	// This test proposes independent targets; the shared harness's n1 -> n2
	// edge is an unfinished media dependency, tested separately below.
	doc := h.canvas(t)
	doc["connections"] = []any{}
	raw, _ := json.Marshal(doc)
	if _, err := h.service.UpsertUserCanvasProject(h.userID, raw); err != nil {
		t.Fatal(err)
	}
	h.revision = int64(h.canvas(t)["revision"].(float64))

	descriptor, found := h.registry.Descriptor("canvas.generation.propose")
	if !found {
		t.Fatal("canvas.generation.propose 未注册")
	}
	if !descriptor.ReadOnly {
		t.Fatal("生成提议不应被登记为写操作：它不写画布也不扣费")
	}

	result, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1", "n2"}, "kind": "image", "note": "做两张分镜图"}, false)
	if err != nil {
		t.Fatalf("提议应成功: %v", err)
	}
	payload, isObject := result.Result.(map[string]any)
	if !isObject {
		t.Fatalf("结果形状异常: %#v", result.Result)
	}
	if payload["model"] != "gpt-image-2" || payload["modelKey"] != "beefapi::gpt-image-2" {
		t.Fatalf("应回画布默认图片模型: %#v", payload)
	}
	source := payload["source"].(map[string]any)
	if source["canvasId"] != h.canvasID || source["canvasRevision"] != float64(h.revision) || source["modelConfigRevision"] != float64(1) {
		t.Fatalf("提案必须绑定原始画布和全局配置版本: %#v", source)
	}
	if payload["kind"] != "image" || payload["note"] != "做两张分镜图" {
		t.Fatalf("提议内容异常: %#v", payload)
	}
	if id, _ := payload["proposalId"].(string); id == "" {
		t.Fatal("提议必须有稳定标识")
	}
	nodeIDs, _ := payload["nodeIds"].([]any)
	if len(nodeIDs) != 2 {
		t.Fatalf("节点列表异常: %#v", payload["nodeIds"])
	}
	// 画布内容不能被提议改动。
	after, err := h.run(t, "canvas.get", "", map[string]any{"canvasId": h.canvasID}, true)
	if err != nil {
		t.Fatal(err)
	}
	canvas, _ := after.Result.(map[string]any)["canvas"].(map[string]any)
	if got, _ := canvas["revision"].(float64); int64(got) != h.revision {
		t.Fatalf("提议不应推进画布版本：%d → %v", h.revision, canvas["revision"])
	}
}

func TestGenerationProposeRejectsDependenciesWithoutMutationOrTasks(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	for _, state := range []string{"empty", "running", "ready"} {
		t.Run(state, func(t *testing.T) {
			h.patchNode(t, "n1", func(node map[string]any) {
				meta := node["metadata"].(map[string]any)
				if state != "empty" {
					meta["content"] = "local-reference"
				}
				if state == "running" {
					meta["taskStatus"] = "running"
				}
				if state == "ready" {
					meta["taskStatus"] = "succeeded"
				}
			})
			before, err := h.service.UserCanvasProject(h.userID, h.canvasID)
			if err != nil {
				t.Fatal(err)
			}
			for _, ids := range [][]string{{"n1", "n2"}, {"n2"}, {"n1"}} {
				_, err := h.run(t, "canvas.generation.propose", "", map[string]any{"canvasId": h.canvasID, "nodeIds": ids, "kind": "image"}, false)
				blocked := len(ids) == 2 || (ids[0] == "n2" && state != "ready")
				if blocked {
					if err == nil || operations.AsError(err).Reason != "generation_dependencies_not_ready" {
						t.Fatalf("targets=%v state=%s: expected dependency rejection, got %v", ids, state, err)
					}
				} else if err != nil {
					t.Fatalf("targets=%v state=%s: %v", ids, state, err)
				}
			}
			after, err := h.service.UserCanvasProject(h.userID, h.canvasID)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("proposal validation changed the canvas")
			}
			tasks, err := h.service.Tasks(h.userID, 10)
			if err != nil {
				t.Fatal(err)
			}
			if len(tasks) != 0 {
				t.Fatalf("proposal created paid tasks: %#v", tasks)
			}
		})
	}
}

func TestGenerationProposeGlobalParameterChangeAdvancesSourceWithoutChangingModel(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	config, err := workspace.NewProviderConfig(h.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, count := range []string{"2", "4"} {
		if err := config.SaveLocalModelConfig([]byte(`{"imageModel":"beefapi::gpt-image-2","canvasImageCount":"` + count + `"}`)); err != nil {
			t.Fatal(err)
		}
		state, _, err := config.LoadEffectiveModelConfig()
		if err != nil {
			t.Fatal(err)
		}
		result, err := h.run(t, "canvas.generation.propose", "", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}, true)
		if err != nil {
			t.Fatal(err)
		}
		payload := result.Result.(map[string]any)
		source := payload["source"].(map[string]any)
		if payload["modelKey"] != "beefapi::gpt-image-2" || source["modelConfigRevision"] != float64(state.Revision) || state.Revision <= 1 || source["canvasRevision"] != float64(h.revision) {
			t.Fatalf("参数修改应只推进配置版本: %#v", payload)
		}
	}
}

func TestGenerationProposeBindsCurrentCanvasRevision(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	params := map[string]any{"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}
	before, err := h.run(t, "canvas.generation.propose", "", params, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.run(t, "canvas.node.update", "f02-prompt-edit", map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"prompt": "changed"}}, false); err != nil {
		t.Fatal(err)
	}
	after, err := h.run(t, "canvas.generation.propose", "", params, true)
	if err != nil {
		t.Fatal(err)
	}
	oldSource := before.Result.(map[string]any)["source"].(map[string]any)
	newSource := after.Result.(map[string]any)["source"].(map[string]any)
	if oldSource["canvasRevision"] != float64(h.revision) || newSource["canvasRevision"] != float64(h.revision+1) || newSource["modelConfigRevision"] != oldSource["modelConfigRevision"] {
		t.Fatalf("提案来源版本错误: before=%#v after=%#v", oldSource, newSource)
	}
}

func TestGenerationProposeRejectsForeignNodesAndBadInput(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)

	cases := []struct {
		name   string
		params map[string]any
	}{
		{"节点不属于本画布", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{"n1", "ghost"}, "kind": "image"}},
		{"未知类型", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "audio"}},
		{"空节点列表", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{}, "kind": "image"}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if _, err := h.run(t, "canvas.generation.propose", "", item.params, false); err == nil {
				t.Fatal("应被拒绝")
			} else if code := opCode(t, err); code != agentops.CodeInvalidArgument {
				t.Fatalf("应是参数错误，得到 %v", code)
			}
		})
	}
}

// 没有配置默认生成模型时必须明确失败：不能给出一个用户无法执行的提议。
func TestGenerationProposeFailsWithoutCanvasDefaultModel(t *testing.T) {
	h := newHarness(t)
	h.patchNode(t, "n1", func(node map[string]any) {
		node["type"] = "video"
	})

	_, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "video"}, false)
	if err == nil {
		t.Fatal("没有默认视频模型时应失败")
	}
	if reason := agentops.AsError(err).Reason; reason != "generation_model_not_configured" {
		t.Fatalf("reason 应为 generation_model_not_configured，得到 %q", reason)
	}
}

func TestGenerationProposeUsesNodeOverrideBeforeGlobalDefault(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	h.setNodeModel(t, "n1", "beefapi::gpt-image-2.5-flare")

	got := h.canvas(t)
	metadata := got["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)
	if metadata["model"] != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("canvas.get 应看到节点覆盖模型: %#v", metadata)
	}

	result, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}, true)
	if err != nil {
		t.Fatalf("提议应成功: %v", err)
	}
	payload := result.Result.(map[string]any)
	if payload["model"] != "gpt-image-2.5-flare" || payload["modelKey"] != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("提议应使用节点覆盖模型而不是全局默认: %#v", payload)
	}
	source := payload["source"].(map[string]any)
	if source["canvasId"] != h.canvasID || source["modelConfigRevision"] != float64(1) {
		t.Fatalf("提案仍须绑定画布与配置版本: %#v", source)
	}
}

func TestGenerationProposeNormalizesUnqualifiedNodeModel(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	h.setNodeModel(t, "n1", "gpt-image-2.5-flare")

	result, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}, true)
	if err != nil {
		t.Fatalf("提议应成功: %v", err)
	}
	payload := result.Result.(map[string]any)
	if payload["model"] != "gpt-image-2.5-flare" || payload["modelKey"] != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("未带渠道前缀的节点模型应归一为渠道模型键: %#v", payload)
	}
}

func TestGenerationProposeFallsBackToDefaultWhenNodeHasNoModel(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)

	result, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}, true)
	if err != nil {
		t.Fatal(err)
	}
	payload := result.Result.(map[string]any)
	if payload["modelKey"] != "beefapi::gpt-image-2" || payload["model"] != "gpt-image-2" {
		t.Fatalf("未设置节点模型时应回退全局默认: %#v", payload)
	}
}

func TestGenerationProposeRejectsMixedNodeModels(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	h.setNodeModel(t, "n1", "beefapi::gpt-image-2.5-flare")
	h.setNodeModel(t, "n2", "beefapi::gpt-image-2")

	_, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1", "n2"}, "kind": "image"}, false)
	if err == nil {
		t.Fatal("不同节点模型必须拒绝，不能静默挑选其中一个")
	}
	if reason := agentops.AsError(err).Reason; reason != "mixed_generation_models" {
		t.Fatalf("reason 应为 mixed_generation_models，得到 %q", reason)
	}
}

func TestGenerationProposeRejectsKindMismatch(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	h.patchNode(t, "n1", func(node map[string]any) {
		node["type"] = "video"
	})

	_, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}, false)
	if err == nil {
		t.Fatal("视频节点的图片提议应被拒绝")
	}
	if reason := agentops.AsError(err).Reason; reason != "generation_kind_mismatch" {
		t.Fatalf("reason 应为 generation_kind_mismatch，得到 %q", reason)
	}

	h.patchNode(t, "n1", func(node map[string]any) {
		node["type"] = "image"
	})
	h.setNodeModel(t, "n1", "beefapi::wan3.0-video")
	_, err = h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image"}, false)
	if err == nil {
		t.Fatal("节点上的视频模型不能用于图片提议")
	}
	if reason := agentops.AsError(err).Reason; reason != "generation_model_kind_mismatch" {
		t.Fatalf("reason 应为 generation_model_kind_mismatch，得到 %q", reason)
	}
}
