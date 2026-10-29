package operations_test

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestVideoBindingRecoversAcceptedPendingNodeWithoutTaskID(t *testing.T) {
	for _, state := range []string{"pending", "different-operation", "different-task", "has-media", "different-target", "no-admission"} {
		t.Run(state, func(t *testing.T) {
			h := newHarness(t)
			now := time.Now()
			operationID := "accepted-video-operation"
			task := model.Task{ID: "paid-video", UserID: h.userID, ProjectID: h.canvasID, Type: "canvas_video",
				ClientOperationID: &operationID, Status: model.TaskStatusSucceeded,
				InputJSON:  `{"metadata":{"source":"canvas","nodeId":"video-node"}}`,
				ResultJSON: `{"mode":"video","video":{"resourceId":"video-result","storageKey":"resource:video-result"}}`,
				CreatedAt:  now, UpdatedAt: now, CompletedAt: &now}
			if state == "different-target" {
				task.InputJSON = `{"metadata":{"source":"canvas","nodeId":"another-node"}}`
			}
			if state == "no-admission" {
				task.ClientOperationID = nil
			}
			if err := h.service.Database().Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := h.service.Database().Create(&model.Resource{ID: "video-result", UserID: h.userID, Kind: "video", Status: model.ResourceStatusReady,
				MimeType: "video/mp4", Width: 720, Height: 1280, Size: 24, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			// Deliver before the node exists so this test controls the first binding attempt.
			if err := h.service.DeliverSucceededTask(task); err != nil {
				t.Fatal(err)
			}
			metadata := map[string]any{"status": "error", "taskClientOperationId": operationID}
			if state == "different-operation" {
				metadata["taskClientOperationId"] = "newer-operation"
			}
			if state == "different-task" {
				metadata["taskId"] = "newer-task"
			}
			if state == "has-media" {
				metadata["storageKey"] = "resource:video-result"
				metadata["assetId"] = localtask.MaterializedAssetID(task.ID, 0)
			}
			h.addNode(t, "video-node", "video", "用户改过的标题", metadata)
			_, err := h.bindTask(t, task.ID, "video-node", 0)
			if state != "pending" {
				want := "node_task_mismatch"
				if state == "different-target" {
					want = "node_mismatch"
				}
				if opErr(t, err).Reason != want {
					t.Fatalf("unsafe recovery allowed or wrong error: %v", err)
				}
				if h.nodeMetaString(t, "video-node", "taskId") == task.ID {
					t.Fatal("replaced node overwritten")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.bindTask(t, task.ID, "video-node", 0); err != nil {
				t.Fatal(err)
			}
			if h.nodeMetaString(t, "video-node", "taskId") != task.ID || h.nodeMetaString(t, "video-node", "status") != "success" {
				t.Fatal("original output was not recovered")
			}
			if h.nodeMetaString(t, "video-node", "taskType") != "canvas_video" {
				t.Fatal("binding receipt lost the authoritative task kind")
			}
			if h.count(t, &model.Task{}) != 1 || h.count(t, &model.Asset{}) != 1 || h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "video-node", 0)) != 1 {
				t.Fatal("recovery duplicated a task, asset, or receipt")
			}
		})
	}
}
