package operations_test

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestDepthDeliveryRepairsAndBindsOnlyOriginalNode(t *testing.T) {
	for _, target := range []string{"live", "deleted", "replaced", "legacy", "pending", "pending-other-operation", "pending-other-target", "pending-has-media"} {
		t.Run(target, func(t *testing.T) {
			h := newHarness(t)
			now := time.Now()
			operationID := "depth:pending-operation"
			task := model.Task{ID: "depth-task", UserID: h.userID, ProjectID: h.canvasID,
				ClientOperationID: &operationID,
				Type:              model.TaskTypeDepthCapture, Status: model.TaskStatusSucceeded,
				InputJSON:  `{"metadata":{"source":"canvas","nodeId":"depth-node"}}`,
				ResultJSON: `{"resourceId":"depth-result","width":1920,"height":1080}`,
				CreatedAt:  now, UpdatedAt: now, CompletedAt: &now}
			if target == "legacy" {
				task.InputJSON = `{"resourceId":"source-video"}`
			}
			if target == "pending-other-target" {
				task.InputJSON = `{"metadata":{"source":"canvas","nodeId":"different-node"}}`
			}
			if err := h.service.Database().Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			h.addNode(t, "depth-node", "video", "Keep title", map[string]any{"taskId": task.ID, "status": "loading", "depthSourceNodeId": "source-node", "taskClientOperationId": operationID})
			if target == "pending" || target == "pending-other-operation" || target == "pending-other-target" || target == "pending-has-media" {
				node := h.node(t, "depth-node")
				metadata := nodeMeta(node)
				delete(metadata, "taskId")
				metadata["depthSourceNodeId"] = "source-node"
				metadata["taskClientOperationId"] = operationID
				if target == "pending-other-operation" {
					metadata["taskClientOperationId"] = "depth:other-operation"
				}
				if target == "pending-has-media" {
					metadata["assetId"] = "existing-asset"
				}
				h.replaceNode(t, "depth-node", node)
			}
			if target == "deleted" {
				h.deleteNode(t, "depth-node")
			}
			if target == "replaced" {
				node := h.node(t, "depth-node")
				nodeMeta(node)["taskId"] = "newer-task"
				h.replaceNode(t, "depth-node", node)
			}
			// The result exists in the task journal before its resource is readable.
			_ = h.service.DeliverSucceededTask(task)
			stored, err := h.service.Task(h.userID, task.ID)
			if err != nil || stored.Status != model.TaskStatusSucceeded || stored.ResultState != localtask.ResultStateFailedRetryable {
				t.Fatalf("delivery failure changed execution: %#v %v", stored, err)
			}
			if err := h.service.Database().Create(&model.Resource{ID: "depth-result", UserID: h.userID, Kind: "video", Status: model.ResourceStatusReady,
				MimeType: "video/mp4", Width: 1920, Height: 1080, Size: 100, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err := h.service.RecoverIncompleteGenerationDeliveries(64); err != nil {
					t.Fatal(err)
				}
			}
			if target == "legacy" {
				if _, err := h.bindTask(t, task.ID, "depth-node", 0); err != nil {
					t.Fatal(err)
				}
			}
			switch target {
			case "pending-other-operation", "pending-other-target", "pending-has-media":
				wantReason := "node_task_mismatch"
				if target == "pending-other-target" {
					wantReason = "node_mismatch"
				}
				if _, err := h.bindTask(t, task.ID, "depth-node", 0); opErr(t, err).Reason != wantReason {
					t.Fatalf("unsafe pending bind: %v", err)
				}
				if h.nodeMetaString(t, "depth-node", "taskId") != "" {
					t.Fatal("unrelated pending node bound")
				}
			case "deleted":
				if h.findNode(t, "depth-node") != nil {
					t.Fatal("deleted node revived")
				}
			case "replaced":
				if h.nodeMetaString(t, "depth-node", "taskId") != "newer-task" {
					t.Fatal("newer task overwritten")
				}
			default:
				if h.nodeMetaString(t, "depth-node", "status") != "success" || h.nodeMetaString(t, "depth-node", "assetId") != localtask.MaterializedAssetID(task.ID, 0) {
					t.Fatal("depth result not bound")
				}
				if h.node(t, "depth-node")["title"] != "Keep title" {
					t.Fatal("manual title overwritten")
				}
			}
			if h.count(t, &model.Asset{}) != 1 || h.count(t, &model.AssetRepresentation{}) != 1 {
				t.Fatal("repair duplicated output")
			}
		})
	}
}
