package canvas

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func preparationFixture(t *testing.T) (*Service, string, int64, []string) {
	t.Helper()
	svc, id, nodeID, revision := storyboardFixture(t)
	summary, rows, err := svc.AppendUserCanvasStoryboardRows("owner", id, nodeID, []StoryboardRowDraft{
		{DurationSeconds: floatPtr(5), ImageGenerationPrompt: strPtr("first frame"), VideoMotionPrompt: strPtr("first motion")},
		{DurationSeconds: floatPtr(7), ImageGenerationPrompt: strPtr("second frame"), VideoMotionPrompt: strPtr("second motion")},
	}, revision)
	if err != nil {
		t.Fatal(err)
	}
	return svc, id, summary.Revision, []string{rows[0].ID, rows[1].ID}
}

func TestPrepareStoryboardAtomicGraphAndPreservation(t *testing.T) {
	svc, id, revision, rows := preparationFixture(t)
	before, _ := svc.loadCanvasDoc("owner", id)
	summary, result, err := svc.PrepareUserCanvasStoryboard("owner", id, "script", StoryboardPreparation{RowIDs: rows, Image: map[string]any{"model": "image-model", "size": "9:16"}, Video: map[string]any{"model": "video-model", "generateAudio": "true"}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Revision != revision+1 || len(result.Created) != 4 || len(result.CreatedEdgeIDs) != 6 || len(result.Shots) != 2 {
		t.Fatalf("incomplete result: %#v %#v", summary, result)
	}
	doc, _ := svc.loadCanvasDoc("owner", id)
	if !reflect.DeepEqual(findCanvasNode(before, "txt"), findCanvasNode(doc, "txt")) {
		t.Fatal("unrelated node modified")
	}
	for i, shot := range result.Shots {
		row := findStoryboardRow(docStoryboardForTest(doc), rows[i])
		image := findCanvasNode(doc, shot.ImageNodeID)
		video := findCanvasNode(doc, shot.VideoNodeID)
		if row["imageNodeId"] != image["id"] || row["videoNodeId"] != video["id"] {
			t.Fatal("row binding lost")
		}
		im := image["metadata"].(map[string]any)
		vm := video["metadata"].(map[string]any)
		if im["count"] != float64(1) || vm["videoEditOperation"] != "image_to_video" || vm["videoStartFrameNodeId"] != shot.ImageNodeID {
			t.Fatal("draft must pin one image and its explicit video first frame")
		}
		if im["composerContent"] != row["imageGenerationPrompt"] || vm["composerContent"] != row["videoMotionPrompt"] || vm["generateAudio"] != "true" {
			t.Fatal("draft lost source content or sound")
		}
		if vm["seconds"] != []string{"5", "7"}[i] {
			t.Fatal("row duration not used")
		}
	}
	stable, _ := svc.UserCanvasProject("owner", id)
	if _, _, err := svc.PrepareUserCanvasStoryboard("owner", id, "script", StoryboardPreparation{RowIDs: rows, Image: map[string]any{"model": "different"}}, summary.Revision); err == nil {
		t.Fatal("existing bound output overwritten")
	}
	after, _ := svc.UserCanvasProject("owner", id)
	if string(stable) != string(after) {
		t.Fatal("rejected preparation changed canvas")
	}
}

func docStoryboardForTest(doc map[string]any) []any {
	return findCanvasNode(doc, "script")["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)
}

func TestPrepareStoryboardKeepsPerRowReferences(t *testing.T) {
	svc, id, revision, rows := preparationFixture(t)
	doc, _ := svc.loadCanvasDoc("owner", id)
	for _, nodeID := range []string{"style", "prop", "character", "row-input"} {
		metadata := map[string]any{}
		if nodeID == "character" {
			metadata["workflowKind"] = "character"
			metadata["characterAssetId"] = "actor"
		}
		doc["nodes"] = append(canvasDocNodes(doc), map[string]any{"id": nodeID, "type": "image", "title": nodeID, "metadata": metadata})
	}
	storyboard := findCanvasNode(doc, "script")["metadata"].(map[string]any)["storyboard"].(map[string]any)
	storyboard["referenceNodeIds"] = []any{"style"}
	row := findStoryboardRow(docStoryboardForTest(doc), rows[0])
	row["assetBindings"] = []any{map[string]any{"nodeId": "prop"}}
	row["characters"] = []any{map[string]any{"characterAssetId": "actor"}}
	doc["connections"] = []any{map[string]any{"id": "row-ref", "fromNodeId": "row-input", "toNodeId": "script", "toHandleId": "row:" + rows[0]}}
	summary, err := svc.saveCanvasDocWithRevision("owner", id, doc, revision)
	if err != nil {
		t.Fatal(err)
	}
	_, prepared, err := svc.PrepareUserCanvasStoryboard("owner", id, "script", StoryboardPreparation{RowIDs: rows, Image: map[string]any{"model": "image"}}, summary.Revision)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := svc.loadCanvasDoc("owner", id)
	for i, shot := range prepared.Shots {
		refs := map[string]bool{}
		for _, raw := range after["connections"].([]any) {
			edge := raw.(map[string]any)
			if edge["toNodeId"] == shot.ImageNodeID && edge["relation"] == "storyboard-asset-reference" {
				refs[edge["fromNodeId"].(string)] = true
			}
		}
		want := map[string]bool{"style": true}
		if i == 0 {
			want["prop"] = true
			want["character"] = true
			want["row-input"] = true
		}
		if !reflect.DeepEqual(refs, want) {
			t.Fatalf("row %d references %v want %v", i, refs, want)
		}
	}
}

func TestPrepareStoryboardValidationAndConflictLeaveNoPartialWrites(t *testing.T) {
	for _, tc := range []string{"missing-last-row", "duplicate-row", "foreign-reference", "invalid-last-kind", "stale", "foreign-owner"} {
		t.Run(tc, func(t *testing.T) {
			svc, id, revision, rows := preparationFixture(t)
			input := StoryboardPreparation{RowIDs: rows, Image: map[string]any{"model": "image"}, Video: map[string]any{"model": "video"}}
			owner := "owner"
			switch tc {
			case "missing-last-row":
				input.RowIDs[1] = "missing"
			case "duplicate-row":
				input.RowIDs[1] = rows[0]
			case "foreign-reference":
				input.ReferenceNodeIDs = []string{"other-image"}
			case "invalid-last-kind":
				input.Video["taskId"] = "forged"
			case "stale":
				revision--
			case "foreign-owner":
				owner = "other"
			}
			before, _ := svc.UserCanvasProject("owner", id)
			if _, _, err := svc.PrepareUserCanvasStoryboard(owner, id, "script", input, revision); err == nil {
				t.Fatal("invalid preparation accepted")
			}
			after, _ := svc.UserCanvasProject("owner", id)
			if string(before) != string(after) {
				t.Fatal("partial graph persisted")
			}
		})
	}
}

func TestPrepareVideoUsesExistingImageAndReferenceIsNotVideoFirstFrame(t *testing.T) {
	svc, id, revision, rows := preparationFixture(t)
	summary, refs, err := svc.CreateUserCanvasNodes("owner", id, []NodeDraft{{Title: "character", Type: "image"}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	summary, images, err := svc.PrepareUserCanvasStoryboard("owner", id, "script", StoryboardPreparation{RowIDs: rows, ReferenceNodeIDs: []string{refs[0].ID}, Image: map[string]any{"model": "image", "size": "9:16"}}, summary.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, videos, err := svc.PrepareUserCanvasStoryboard("owner", id, "script", StoryboardPreparation{RowIDs: rows, Video: map[string]any{"model": "video"}}, summary.Revision)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := svc.loadCanvasDoc("owner", id)
	for i, shot := range videos.Shots {
		if shot.ImageNodeID != images.Shots[i].ImageNodeID {
			t.Fatal("lost existing image")
		}
		video := findCanvasNode(doc, shot.VideoNodeID)
		width, height := video["width"].(float64), video["height"].(float64)
		if width < 420 || math.Abs(width/height-9.0/16) > 0.001 {
			t.Fatal("video without explicit size must preserve its readable portrait frame geometry")
		}
		if i > 0 {
			previous := findCanvasNode(doc, videos.Shots[i-1].VideoNodeID)
			gap := video["position"].(map[string]any)["y"].(float64) - previous["position"].(map[string]any)["y"].(float64) - previous["height"].(float64)
			if gap < 79.99 {
				t.Fatalf("portrait result would overlap its neighbour: gap %g", gap)
			}
		}
		matches := 0
		for _, raw := range doc["connections"].([]any) {
			edge := raw.(map[string]any)
			if edge["toNodeId"] == shot.VideoNodeID && edge["fromNodeId"] != "script" {
				if edge["fromNodeId"] != shot.ImageNodeID {
					t.Fatal("character reference incorrectly used as video frame")
				}
				matches++
			}
		}
		if matches != 1 {
			t.Fatalf("video frame count %d", matches)
		}
	}
	encoded, _ := json.Marshal(doc)
	if len(encoded) == 0 {
		t.Fatal("invalid graph")
	}
}
