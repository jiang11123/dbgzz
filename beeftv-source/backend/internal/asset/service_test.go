package asset

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

type listingRepository struct {
	Repository
	resources []model.Resource
}

func (f listingRepository) Resources(string, int) ([]model.Resource, error) { return f.resources, nil }

func TestLocalServiceRejectsCloudAndMissingReadyAssets(t *testing.T) {
	root := t.TempDir()
	tests := []model.Resource{
		{ID: "cloud", Provider: "s3", Status: model.ResourceStatusReady, ObjectKey: "cloud.png"},
		{ID: "missing", Provider: "local", Status: model.ResourceStatusReady, ObjectKey: "missing.png"},
	}
	for _, resource := range tests {
		service := NewService(Dependencies{Repository: listingRepository{resources: []model.Resource{resource}}, Blobs: NewFileStore(root), LocalStorage: true})
		if _, err := service.Resources("local", 10); err == nil {
			t.Fatalf("resource %s was accepted by the local asset boundary", resource.ID)
		}
	}
}
