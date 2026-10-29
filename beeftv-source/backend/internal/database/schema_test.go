package database

import (
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm/schema"
)

func TestAssetIDColumnsUseSharedLimit(t *testing.T) {
	tests := []struct {
		value any
		field string
	}{
		{value: &model.Asset{}, field: "ID"},
		{value: &model.ProjectAssetLink{}, field: "AssetID"},
		{value: &model.ProjectAssetCandidate{}, field: "ResolvedAssetID"},
		{value: &model.AssetVersion{}, field: "AssetID"},
	}

	for _, test := range tests {
		parsed, err := schema.Parse(test.value, &sync.Map{}, schema.NamingStrategy{})
		if err != nil {
			t.Fatalf("parse schema: %v", err)
		}
		field := parsed.LookUpField(test.field)
		if field == nil {
			t.Fatalf("field %s not found in %s", test.field, parsed.Table)
		}
		if field.Size != model.AssetIDMaxLength {
			t.Fatalf("%s.%s size = %d, want %d", parsed.Table, field.DBName, field.Size, model.AssetIDMaxLength)
		}
	}
}
