package asset

import (
	"encoding/json"
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProjectExportReceiptsProtectOnlyOwnedSuccessfulExactResources(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	resources := make([]model.Resource, 0, 6)
	for _, id := range []string{"archive-1", "archive-10", "foreign", "failed", "other-op", "bad-ref"} {
		r := model.Resource{ID: id, UserID: "owner", Provider: "local", MimeType: "application/zip", Status: model.ResourceStatusReady}
		if err := db.Create(&r).Error; err != nil {
			t.Fatal(err)
		}
		resources = append(resources, r)
	}
	for _, row := range []struct{ user, op, status, id, key string }{
		{"owner", "canvas.project.export", "succeeded", "archive-1", "resource:archive-1"},
		{"another-user", "canvas.project.export", "succeeded", "foreign", "resource:foreign"},
		{"owner", "canvas.project.export", "failed", "failed", "resource:failed"},
		{"owner", "canvas.timeline.render", "succeeded", "other-op", "resource:other-op"},
		{"owner", "canvas.project.export", "succeeded", "bad-ref", "resource:unrelated"},
	} {
		raw, _ := json.Marshal(map[string]any{"resourceId": row.id, "storageKey": row.key})
		if err := db.Create(&model.AgentOpRecord{UserID: row.user, OpID: "export-" + row.id, Op: row.op, Status: row.status, ResultJSON: string(raw)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(db)
	refs, err := repo.ProjectExportResourceReferences("owner", []string{"archive-1", "archive-10", "foreign", "failed", "other-op", "bad-ref"})
	if err != nil || len(refs) != 1 || refs[0].ResourceID != "archive-1" {
		t.Fatalf("wrong receipt references %+v %v", refs, err)
	}
	if err := svc.CleanupDetachedUserResources("owner", resources); err != nil {
		t.Fatal(err)
	}
	var remaining []model.Resource
	if err := db.Find(&remaining).Error; err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].ID != "archive-1" {
		t.Fatalf("cleanup removed export or retained unrelated resources: %+v", remaining)
	}
	// A receipt committed after the service snapshot must also stop the final
	// transaction from deleting the newly referenced archive.
	if err := repo.DeleteDetachedResources(remaining, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("transaction missed export receipt: %v", err)
	}
}
