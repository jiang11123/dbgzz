package canvas

import (
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

// StoryboardPreparation creates the production drafts for existing, authored
// rows. It does not submit generation or replace any existing output.
type StoryboardPreparation struct {
	Script           *StoryboardDraft
	RowIDs           []string
	Image, Video     map[string]any
	ReferenceNodeIDs []string
}

type StoryboardDraft struct {
	Title string               `json:"title"`
	Rows  []StoryboardRowDraft `json:"rows"`
}

type PreparedStoryboardShot struct {
	RowID       string `json:"rowId"`
	ImageNodeID string `json:"imageNodeId,omitempty"`
	VideoNodeID string `json:"videoNodeId,omitempty"`
}

type StoryboardPreparationResult struct {
	ScriptNodeID   string                   `json:"scriptNodeId,omitempty"`
	Created        []CreatedNode            `json:"created"`
	CreatedEdgeIDs []string                 `json:"createdEdgeIds"`
	Shots          []PreparedStoryboardShot `json:"shots"`
}

// PrepareUserCanvasStoryboard creates, configures, lays out and binds one batch
// in a single canvas revision. A failed row cannot leave half a production graph.
func (s *Service) PrepareUserCanvasStoryboard(userID, canvasID, nodeID string, input StoryboardPreparation, expectedRevision int64) (UserDataSummary, StoryboardPreparationResult, error) {
	result := StoryboardPreparationResult{Created: []CreatedNode{}, CreatedEdgeIDs: []string{}, Shots: []PreparedStoryboardShot{}}
	fail := func(message string) (UserDataSummary, StoryboardPreparationResult, error) {
		return UserDataSummary{}, StoryboardPreparationResult{}, kernel.NewAppError(http.StatusBadRequest, message)
	}
	if err := requireExpectedRevision(expectedRevision); err != nil {
		return UserDataSummary{}, result, err
	}
	if (input.Script == nil && len(input.RowIDs) < 1) || len(input.RowIDs) > 8 || len(input.ReferenceNodeIDs) > 4 || (len(input.Image) == 0 && len(input.Video) == 0) {
		return fail("请选择 1..8 个分镜及图片或视频参数，参考图片最多 4 张")
	}
	if len(input.Image) == 0 && len(input.ReferenceNodeIDs) > 0 {
		return fail("角色或风格参考用于首帧图片；视频沿用各分镜自己的首帧")
	}
	var doc, storyboard map[string]any
	var rows []any
	var err error
	if input.Script == nil {
		doc, storyboard, rows, err = s.loadStoryboardRows(userID, canvasID, nodeID)
	} else {
		if nodeID != "" || len(input.RowIDs) > 0 || len(input.Script.Rows) > 8 {
			return fail("新分镜与已有分镜请选择一种")
		}
		if err := requireStoryboardRows(input.Script.Rows); err != nil {
			return UserDataSummary{}, result, err
		}
		doc, err = s.loadCanvasDoc(userID, canvasID)
		if err == nil {
			result.Created, err = createCanvasNodes(doc, []NodeDraft{{Title: input.Script.Title, Type: storyboardNodeType}})
		}
		if err == nil {
			nodeID = result.Created[0].ID
			result.ScriptNodeID = nodeID
			metadata := findCanvasNode(doc, nodeID)["metadata"].(map[string]any)
			storyboard = metadata["storyboard"].(map[string]any)
			for i, draft := range input.Script.Rows {
				row := buildStoryboardRow(i+1, draft)
				rows = append(rows, row)
				input.RowIDs = append(input.RowIDs, rowIDOf(row))
			}
		}
	}
	if err != nil {
		return UserDataSummary{}, result, err
	}
	seenReferences := map[string]bool{}
	for _, id := range input.ReferenceNodeIDs {
		if seenReferences[id] {
			return fail("参考图片重复: " + id)
		}
		seenReferences[id] = true
		if node := findCanvasNode(doc, id); node == nil || canvasNodeType(node) != "image" {
			return fail("参考图片不在当前画布: " + id)
		}
	}
	seen := map[string]bool{}
	rowReferences := map[string][]string{}
	for _, id := range input.RowIDs {
		row := findStoryboardRow(rows, id)
		if row == nil || seen[id] {
			return fail("分镜不存在或重复: " + id)
		}
		seen[id] = true
		refs, refErr := storyboardPreparationReferences(doc, storyboard, row, nodeID, input.ReferenceNodeIDs)
		if refErr != nil {
			return fail(refErr.Error())
		}
		rowReferences[id] = refs
		if len(input.Video) > 0 {
			seconds, ok := row["durationSeconds"].(float64)
			if !ok || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < StoryboardMinShotSeconds || seconds > StoryboardMaxShotSeconds {
				return fail("请先填写有效的分镜时长")
			}
		}
		for _, kind := range []string{"image", "video"} {
			patch := input.Image
			promptField := "imageGenerationPrompt"
			if kind == "video" {
				patch = input.Video
				promptField = "videoMotionPrompt"
			}
			if len(patch) == 0 {
				continue
			}
			if bound, _ := row[kind+"NodeId"].(string); bound != "" {
				return fail("分镜已有" + kind + "节点，请修改原节点而不是重复创建")
			}
			if prompt, _ := row[promptField].(string); strings.TrimSpace(prompt) == "" {
				return fail("分镜缺少" + promptField)
			}
		}
		if len(input.Video) > 0 && len(input.Image) == 0 {
			if id, _ := row["imageNodeId"].(string); id != "" {
				if node := findCanvasNode(doc, id); node == nil || canvasNodeType(node) != "image" {
					return fail("分镜首帧节点已不存在，请先修正绑定")
				}
			} else if len(refs) > 0 {
				return fail("此分镜已有角色或素材参考，请先准备首帧图片再制作视频")
			}
		}
	}
	// Two columns, one row per shot. Start to the right of all existing nodes;
	// the canvas remains legible instead of growing one long horizontal strip.
	x := 120.0
	for _, raw := range canvasDocNodes(doc) {
		if node, ok := raw.(map[string]any); ok {
			position, _ := node["position"].(map[string]any)
			left, _ := position["x"].(float64)
			width, _ := node["width"].(float64)
			if width <= 0 {
				if d, ok := canvasCapabilityRegistry.Resolve(canvasNodeType(node)); ok {
					width = d.DefaultWidth
				}
			}
			if right := left + width + nodePlacementGap; right > x {
				x = right
			}
		}
	}
	connect := func(from, to, rowID string) {
		id := newStoryboardEdgeID()
		edges, _ := doc["connections"].([]any)
		doc["connections"] = append(edges, map[string]any{"id": id, "fromNodeId": from, "toNodeId": to, "relation": "storyboard-asset-reference", "storyboardRowId": rowID})
		result.CreatedEdgeIDs = append(result.CreatedEdgeIDs, id)
	}
	imageWidth, imageHeight := storyboardDraftSize(input.Image)
	videoWidth, videoHeight := storyboardDraftSize(input.Video)
	rowStride := math.Max(imageHeight, videoHeight) + 80
	videoSizes := map[string][2]float64{}
	for _, id := range input.RowIDs {
		width, height := videoWidth, videoHeight
		if size, _ := input.Video["size"].(string); size == "" || size == "auto" {
			if len(input.Image) > 0 {
				width, height = imageWidth, imageHeight
			} else if row := findStoryboardRow(rows, id); row != nil {
				frameID, _ := row["imageNodeId"].(string)
				if frame := findCanvasNode(doc, frameID); frame != nil {
					w, _ := frame["width"].(float64)
					h, _ := frame["height"].(float64)
					if w > 0 && h > 0 {
						width, height = storyboardDraftSize(map[string]any{"size": fmt.Sprintf("%g:%g", w, h)})
					}
				}
			}
		}
		videoSizes[id] = [2]float64{width, height}
		rowStride = math.Max(rowStride, height+80)
	}
	for index, id := range input.RowIDs {
		row := findStoryboardRow(rows, id)
		shot := PreparedStoryboardShot{RowID: id}
		shot.ImageNodeID, _ = row["imageNodeId"].(string)
		for _, kind := range []string{"image", "video"} {
			patch := input.Image
			promptField, label := "imageGenerationPrompt", "首帧"
			if kind == "video" {
				patch = input.Video
				promptField, label = "videoMotionPrompt", "视频"
			}
			if len(patch) == 0 {
				continue
			}
			descriptor, _ := canvasCapabilityRegistry.Resolve(kind)
			prompt, _ := row[promptField].(string)
			metadata := descriptor.Metadata(prompt)
			metadata["prompt"] = prompt
			metadata["workflowKind"] = "shot"
			metadata["shotIndex"] = row["shotNumber"]
			createdID := newCanvasNodeID()
			title := fmt.Sprintf("镜头 %d · %s", rowShotNumber(row), label)
			left, width, height := x, imageWidth, imageHeight
			if kind == "video" {
				left, width, height = x+imageWidth+80, videoSizes[id][0], videoSizes[id][1]
			}
			node := map[string]any{"id": createdID, "type": kind, "title": title, "metadata": metadata,
				"position": map[string]any{"x": left, "y": 160 + float64(index)*rowStride}, "width": width, "height": height}
			for name, value := range patch {
				if name == "title" || name == "content" {
					return fail("生成参数不能覆盖分镜提示词或名称")
				}
				if _, exists := descriptor.PatchFields[name]; !exists {
					return fail("不支持的生成参数: " + name)
				}
				if err := descriptor.ApplyPatch(node, map[string]any{name: value}); err != nil {
					return fail(err.Error())
				}
			}
			if kind == "video" {
				seconds, _ := row["durationSeconds"].(float64)
				metadata["seconds"] = strconv.FormatFloat(seconds, 'f', -1, 64)
				metadata["videoEditOperation"] = "text_to_video"
				if shot.ImageNodeID != "" {
					metadata["videoEditOperation"] = "image_to_video"
					metadata["videoStartFrameNodeId"] = shot.ImageNodeID
				}
			} else {
				// Each row owns one first frame, even when the global count is higher.
				metadata["count"] = float64(1)
			}
			doc["nodes"] = append(canvasDocNodes(doc), node)
			result.Created = append(result.Created, CreatedNode{ID: createdID, Title: title, Type: kind})
			edges, _, bindErr := bindStoryboardRowOutput(doc, nodeID, row, kind+"NodeId", kind, createdID)
			if bindErr != nil {
				return UserDataSummary{}, result, bindErr
			}
			result.CreatedEdgeIDs = append(result.CreatedEdgeIDs, edges...)
			if kind == "image" {
				shot.ImageNodeID = createdID
				for _, ref := range rowReferences[id] {
					connect(ref, createdID, id)
				}
			} else {
				shot.VideoNodeID = createdID
				if shot.ImageNodeID != "" {
					connect(shot.ImageNodeID, createdID, id)
				}
			}
		}
		result.Shots = append(result.Shots, shot)
	}
	summary, err := s.saveStoryboardRows(userID, canvasID, doc, storyboard, rows, expectedRevision)
	if err != nil {
		return UserDataSummary{}, StoryboardPreparationResult{}, err
	}
	return summary, result, nil
}

// These are the existing storyboard reference sources also used by the UI
// materializer. Preparation supports image references; unsupported media must
// be reported before saving rather than silently disappearing from the shot.
func storyboardPreparationReferences(doc, storyboard, row map[string]any, scriptID string, explicit []string) ([]string, error) {
	refs := []string{}
	seen := map[string]bool{}
	add := func(value any) {
		if id, ok := value.(string); ok && id != "" && id != scriptID && !seen[id] {
			seen[id] = true
			refs = append(refs, id)
		}
	}
	for _, id := range explicit {
		add(id)
	}
	if items, ok := storyboard["referenceNodeIds"].([]any); ok {
		for _, id := range items {
			add(id)
		}
	}
	if items, ok := row["assetBindings"].([]any); ok {
		for _, raw := range items {
			if binding, ok := raw.(map[string]any); ok {
				add(binding["nodeId"])
			}
		}
	}
	characters := map[string]bool{}
	if items, ok := row["characters"].([]any); ok {
		for _, raw := range items {
			if character, ok := raw.(map[string]any); ok {
				if id, ok := character["characterAssetId"].(string); ok {
					characters[id] = true
				}
			}
		}
	}
	for _, raw := range canvasDocNodes(doc) {
		if node, ok := raw.(map[string]any); ok {
			metadata, _ := node["metadata"].(map[string]any)
			assetID, _ := metadata["characterAssetId"].(string)
			if metadata["workflowKind"] == "character" && assetID != "" && characters[assetID] {
				add(node["id"])
			}
		}
	}
	if edges, ok := doc["connections"].([]any); ok {
		for _, raw := range edges {
			if edge, ok := raw.(map[string]any); ok && edge["toNodeId"] == scriptID && edge["toHandleId"] == "row:"+rowIDOf(row) {
				add(edge["fromNodeId"])
			}
		}
	}
	for _, id := range refs {
		if node := findCanvasNode(doc, id); node == nil || canvasNodeType(node) != "image" {
			return nil, fmt.Errorf("分镜参考 %s 不可用；批量准备只支持当前画布的图片参考", id)
		}
	}
	return refs, nil
}

var storyboardSizePattern = regexp.MustCompile(`(?i)^([0-9]+(?:\.[0-9]+)?)[x:]([0-9]+(?:\.[0-9]+)?)`)

func storyboardDraftSize(patch map[string]any) (float64, float64) {
	ratio := 16.0 / 9
	if size, ok := patch["size"].(string); ok {
		parts := storyboardSizePattern.FindStringSubmatch(strings.TrimSpace(size))
		if len(parts) == 3 {
			w, e1 := strconv.ParseFloat(parts[1], 64)
			h, e2 := strconv.ParseFloat(parts[2], 64)
			if e1 == nil && e2 == nil && w > 0 && h > 0 && w/h >= 0.25 && w/h <= 4 {
				ratio = w / h
			}
		} else if strings.Contains(size, "竖") || strings.Contains(size, "portrait") || strings.Contains(size, "9:16") {
			ratio = 9.0 / 16
		} else if strings.Contains(size, "square") || strings.Contains(size, "1:1") {
			ratio = 1
		}
	}
	// Match the actual empty-media sizing contract (720x405 base, 420x236
	// readable minimum). Smaller draft boxes are expanded on UI load and would
	// overlap their neighbours despite looking non-overlapping in the Go graph.
	width, height := 720.0, 720.0/ratio
	if ratio < 720.0/405 {
		width, height = 405*ratio, 405
	}
	scale := math.Max(1, math.Max(420/width, 236/height))
	return width * scale, height * scale
}
