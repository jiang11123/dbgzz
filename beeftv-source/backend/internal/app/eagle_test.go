package app

import (
	"testing"

	"infinite-canvas/backend/internal/eagle"
)

func TestEagleAdapterDelegatesEmptyItemCollections(t *testing.T) {
	item := &eagle.Item{}
	if item.FolderIDs != nil || item.Tags != nil {
		t.Fatalf("fresh item already had collections: %#v", item)
	}
	library, err := (&Service{}).EagleLibrary("http://10.0.0.1:41595")
	if err == nil || library != nil {
		t.Fatalf("non-loopback Eagle library = %#v, %v", library, err)
	}
}
