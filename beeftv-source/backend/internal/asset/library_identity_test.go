package asset

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestLibraryWritesCanonicalDocumentIdentity(t *testing.T) {
	for _, operation := range []string{"upsert", "replace"} {
		for _, inputID := range []string{"missing", "", " \t ", "  asset-id \n", "asset-id"} {
			t.Run(operation+"/"+inputID, func(t *testing.T) {
				lib, db := newLibraryFixture(t)
				payload := testLibraryAssetPayload("text", map[string]any{
					"id":        inputID,
					"metadata":  json.RawMessage(`{"favorite":true,"extension":{"integer":9007199254740993}}`),
					"extension": json.RawMessage(`{"nested":[null,"kept",9007199254740993]}`),
				})
				if inputID == "missing" {
					delete(payload, "id")
				}
				raw, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				var responseID string
				if operation == "upsert" {
					result, err := lib.UpsertUserAsset("owner", raw)
					if err != nil {
						t.Fatal(err)
					}
					responseID = result.ID
				} else {
					result, err := lib.ReplaceUserAssets("owner", AssetsSyncRequest{Assets: []json.RawMessage{raw}})
					if err != nil || len(result) != 1 {
						t.Fatalf("replace: %v %s", err, result)
					}
					var document struct {
						ID string `json:"id"`
					}
					if err := json.Unmarshal(result[0], &document); err != nil {
						t.Fatal(err)
					}
					responseID = document.ID
				}
				var stored model.Asset
				if err := db.Where("user_id = ?", "owner").First(&stored).Error; err != nil {
					t.Fatal(err)
				}
				var document map[string]json.RawMessage
				if err := json.Unmarshal([]byte(stored.PayloadJSON), &document); err != nil {
					t.Fatal(err)
				}
				var documentID string
				if err := json.Unmarshal(document["id"], &documentID); err != nil {
					t.Fatal(err)
				}
				if stored.ID == "" || stored.ID != documentID || stored.ID != responseID {
					t.Fatalf("identity mismatch: db=%q document=%q response=%q", stored.ID, documentID, responseID)
				}
				if (inputID == "asset-id" || inputID == "  asset-id \n") && stored.ID != "asset-id" {
					t.Fatalf("ID not normalized: %q", stored.ID)
				}
				for _, field := range []string{"metadata", "extension"} {
					if string(document[field]) != string(payload[field].(json.RawMessage)) {
						t.Fatalf("extension changed: %s = %s", field, document[field])
					}
				}
				page, err := lib.UserAssetsPage("owner", 1, 40, UserAssetPageFilter{Favorite: true})
				if err != nil || page.Total != 1 || page.FavoriteTotal != 1 {
					t.Fatalf("favorite lost after write: %#v %v", page, err)
				}
				// A client saving the returned document updates the same database row.
				if _, err := lib.UpsertUserAsset("owner", json.RawMessage(stored.PayloadJSON)); err != nil {
					t.Fatal(err)
				}
				var count int64
				if err := db.Model(&model.Asset{}).Count(&count).Error; err != nil || count != 1 {
					t.Fatalf("roundtrip duplicated asset: %d %v", count, err)
				}
			})
		}
	}
}
