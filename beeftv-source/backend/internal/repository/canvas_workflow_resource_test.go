package repository

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowPinsAreCheckedAtDeletionCommit(t *testing.T) {
	for _, operation := range []string{"asset", "detached"} {
		t.Run(operation, func(t *testing.T) {
			repo, db := newAdmissionRepo(t)
			if err := db.AutoMigrate(&model.CanvasWorkflowResource{}, &model.ProjectAssetLink{}, &model.ProjectAssetCandidate{}, &model.ShotAssetReference{}, &model.AssetVersion{}); err != nil {
				t.Fatal(err)
			}
			resource := seedReadyResource(t, db, "workflow-input", "owner")
			asset := model.Asset{ID: "asset", UserID: "owner"}
			if err := db.Create(&asset).Error; err != nil {
				t.Fatal(err)
			}
			// This pin appears after the service's earlier snapshot. The commit
			// must re-read it before touching the resource row or deletion outbox.
			if err := db.Create(&model.CanvasWorkflowResource{OwnerID: "workflow", UserID: "owner", ResourceID: resource.ID}).Error; err != nil {
				t.Fatal(err)
			}
			var err error
			if operation == "asset" {
				err = repo.DeleteAssetAndResources("owner", asset.ID, []string{resource.ID}, nil)
			} else {
				err = repo.DeleteDetachedResources([]model.Resource{resource}, nil)
			}
			if !errors.Is(err, ErrResourceCleanupStillReferenced) {
				t.Fatalf("workflow pin did not stop deletion: %v", err)
			}
			var count int64
			if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&count).Error; err != nil || count != 1 {
				t.Fatalf("pinned resource was deleted: %d %v", count, err)
			}
		})
	}
}
