package app

import (
	"context"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestMediaAdapterRejectsForeignAndNotReadyResources(t *testing.T) {
	svc := newResourceTestService(t)
	for _, resource := range []model.Resource{
		{ID: "foreign-media", UserID: "other", Provider: "local", Status: model.ResourceStatusReady},
		{ID: "pending-media", UserID: "local", Provider: "local", Status: model.ResourceStatusPending},
	} {
		if err := svc.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	opener := svc.BindDomain(nil).(operations.MediaSourceOpener)
	for _, id := range []string{"foreign-media", "pending-media", "missing-media"} {
		reader, err := opener.OpenMediaResource(context.Background(), "local", id)
		if reader != nil {
			reader.Close()
			t.Fatalf("opened %s", id)
		}
		if err == nil {
			t.Fatalf("accepted %s", id)
		}
	}
}
