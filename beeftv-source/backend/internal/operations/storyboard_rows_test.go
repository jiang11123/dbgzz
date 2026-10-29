package operations

import (
	"encoding/json"
	"strconv"
	"testing"

	"infinite-canvas/backend/internal/canvas"
)

// storyboardProbe 记录 handler 转发给领域的参数，并返回可预测的写入结果。
// revision 模拟真实领域：每次写入推进，写后重读拿到新值（canvasWriteResult 依赖这一点）。
type storyboardProbe struct {
	unusedDomain
	revision int64
	appended []canvas.StoryboardRowDraft
	updated  []canvas.StoryboardRowPatch
	removed  []string
}

func (p *storyboardProbe) UserCanvasProject(string, string) (json.RawMessage, error) {
	return json.RawMessage(`{"id":"c1","revision":` + strconv.FormatInt(p.revision, 10) +
		`,"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{},{},{}]}}}]}`), nil
}

func (p *storyboardProbe) AppendUserCanvasStoryboardRows(_ string, _ string, _ string, drafts []canvas.StoryboardRowDraft, _ int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error) {
	p.appended = drafts
	p.revision = 6
	created := []canvas.StoryboardRowIdentity{{ID: "shot-new", ShotNumber: 4}}
	return canvas.UserDataSummary{Revision: 6}, created, nil
}

func (p *storyboardProbe) UpdateUserCanvasStoryboardRows(_ string, _ string, _ string, patches []canvas.StoryboardRowPatch, _ int64) (canvas.UserDataSummary, canvas.StoryboardRowUpdate, error) {
	p.updated = patches
	p.revision = 7
	return canvas.UserDataSummary{Revision: 7}, canvas.StoryboardRowUpdate{Updated: []canvas.StoryboardRowIdentity{{ID: "shot-1", ShotNumber: 1}},
		CreatedEdgeIDs: []string{"edge-new"}, DeletedEdgeIDs: []string{"edge-old"}}, nil
}

func (p *storyboardProbe) RemoveUserCanvasStoryboardRows(_ string, _ string, _ string, rowIDs []string, _ int64) (canvas.UserDataSummary, int, error) {
	p.removed = rowIDs
	p.revision = 8
	return canvas.UserDataSummary{Revision: 8}, 2, nil
}

func TestOpStoryboardRowsAppendForwardsDrafts(t *testing.T) {
	probe := &storyboardProbe{}
	result, err := opStoryboardRowsAppend(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"script","expectedRevision":5,"rows":[
			{"plotDescription":"夜巷回头","durationSeconds":8,"mustHave":["霓虹灯"],"videoMotionPrompt":"推进"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(probe.appended) != 1 {
		t.Fatalf("rows 转发 = %#v", probe.appended)
	}
	draft := probe.appended[0]
	if draft.PlotDescription == nil || *draft.PlotDescription != "夜巷回头" {
		t.Fatalf("plotDescription = %#v", draft.PlotDescription)
	}
	if draft.DurationSeconds == nil || *draft.DurationSeconds != 8 {
		t.Fatalf("durationSeconds = %#v", draft.DurationSeconds)
	}
	if draft.MustHave == nil || len(*draft.MustHave) != 1 || (*draft.MustHave)[0] != "霓虹灯" {
		t.Fatalf("mustHave = %#v", draft.MustHave)
	}
	if draft.Dialogue != nil {
		t.Fatalf("未给出的字段应为 nil: %#v", draft.Dialogue)
	}
	payload := result.(map[string]any)
	if payload["revision"] != int64(6) {
		t.Fatalf("回执 revision = %#v", payload["revision"])
	}
	created, ok := payload["created"].([]canvas.StoryboardRowIdentity)
	if !ok || len(created) != 1 || created[0].ID != "shot-new" {
		t.Fatalf("回执 created = %#v", payload["created"])
	}
	if payload["rowCount"] != 3 {
		t.Fatalf("回执 rowCount = %#v", payload["rowCount"])
	}
}

// 白名单外字段（如 characters）必须被 unknown_field 拒绝，而不是静默忽略。
func TestOpStoryboardRowsAppendRejectsUnknownField(t *testing.T) {
	probe := &storyboardProbe{}
	_, err := opStoryboardRowsAppend(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"script","expectedRevision":5,"rows":[{"characters":[]}]}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "unknown_field" {
		t.Fatalf("应拒绝白名单外字段，实际 %v", err)
	}
}

func TestOpStoryboardRowUpdateForwardsPatches(t *testing.T) {
	probe := &storyboardProbe{}
	result, err := opStoryboardRowUpdate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"script","expectedRevision":6,"patches":[
			{"rowId":"shot-1","dialogue":"新台词"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(probe.updated) != 1 || probe.updated[0].RowID != "shot-1" {
		t.Fatalf("patches 转发 = %#v", probe.updated)
	}
	if probe.updated[0].Dialogue == nil || *probe.updated[0].Dialogue != "新台词" {
		t.Fatalf("dialogue = %#v", probe.updated[0].Dialogue)
	}
	payload := result.(map[string]any)
	if payload["revision"] != int64(7) {
		t.Fatalf("回执 revision = %#v", payload["revision"])
	}
}

// 绑定字段只在 update 上：nil 不改、空串解绑都要原样到达领域，回执带上领域给出的连线增删。
func TestOpStoryboardRowUpdateForwardsBindingsAndEdgeReceipt(t *testing.T) {
	probe := &storyboardProbe{}
	result, err := opStoryboardRowUpdate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"script","expectedRevision":6,"patches":[
			{"rowId":"shot-1","imageNodeId":"img-1","videoNodeId":""},{"rowId":"shot-2","dialogue":"x"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	first, second := probe.updated[0], probe.updated[1]
	if first.ImageNodeID == nil || *first.ImageNodeID != "img-1" || first.VideoNodeID == nil || *first.VideoNodeID != "" {
		t.Fatalf("binding forward = %#v", first)
	}
	if second.ImageNodeID != nil || second.VideoNodeID != nil {
		t.Fatalf("omitted binding must stay nil: %#v", second)
	}
	payload := result.(map[string]any)
	if created, _ := payload["createdEdgeIds"].([]string); len(created) != 1 || created[0] != "edge-new" {
		t.Fatalf("createdEdgeIds = %#v", payload["createdEdgeIds"])
	}
	if deleted, _ := payload["deletedEdgeIds"].([]string); len(deleted) != 1 || deleted[0] != "edge-old" {
		t.Fatalf("deletedEdgeIds = %#v", payload["deletedEdgeIds"])
	}
	if _, err := opStoryboardRowsAppend(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"script","expectedRevision":5,"rows":[{"imageNodeId":"img-1"}]}`)); err == nil {
		t.Fatal("append must not accept output bindings")
	}
	var update, appendSchema struct {
		Properties map[string]struct {
			Items struct {
				Properties map[string]any `json:"properties"`
			} `json:"items"`
		} `json:"properties"`
	}
	if json.Unmarshal(storyboardRowUpdateSchema(), &update) != nil || json.Unmarshal(storyboardRowsAppendSchema(), &appendSchema) != nil {
		t.Fatal("schema decode")
	}
	for _, field := range []string{"imageNodeId", "videoNodeId"} {
		if update.Properties["patches"].Items.Properties[field] == nil || appendSchema.Properties["rows"].Items.Properties[field] != nil {
			t.Fatalf("%s schema: update=%v append=%v", field, update.Properties["patches"].Items.Properties[field], appendSchema.Properties["rows"].Items.Properties[field])
		}
	}
}

func TestOpStoryboardRowRemoveForwardsRowIds(t *testing.T) {
	probe := &storyboardProbe{}
	_, err := opStoryboardRowRemove(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"script","expectedRevision":7,"rowIds":["shot-1"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(probe.removed) != 1 || probe.removed[0] != "shot-1" {
		t.Fatalf("rowIds 转发 = %#v", probe.removed)
	}
}

// 缺少定位参数必须在 handler 层拒绝，不进入领域。
func TestOpStoryboardRowsRequireTarget(t *testing.T) {
	probe := &storyboardProbe{}
	if _, err := opStoryboardRowsAppend(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"","nodeId":"","expectedRevision":1,"rows":[{}]}`)); err == nil {
		t.Fatal("缺少 canvasId/nodeId 应被拒绝")
	}
	if _, err := opStoryboardRowUpdate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","expectedRevision":1,"patches":[{"rowId":"r"}]}`)); err == nil {
		t.Fatal("缺少 nodeId 应被拒绝")
	}
	if _, err := opStoryboardRowRemove(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","expectedRevision":1,"rowIds":["r"]}`)); err == nil {
		t.Fatal("缺少 nodeId 应被拒绝")
	}
}
