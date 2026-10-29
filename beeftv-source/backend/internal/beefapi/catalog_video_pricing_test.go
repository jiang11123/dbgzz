package beefapi

import (
	"encoding/json"
	"infinite-canvas/backend/internal/workspace"
	"testing"
)

func TestPortraitQuoteRefreshAndRemoval(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	model := CatalogModel{ID: "seedance-2.0-portrait", DisplayName: "Seedance 2.0 真人素材版", VideoPricing: json.RawMessage(`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`)}
	if err := applyCatalog(store, []CatalogModel{model}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	profile := catalogProfile(t, store, model.ID)
	if profile["videoPricing"] == nil {
		t.Fatal("price was dropped before reaching the UI")
	}
	model.VideoPricing = nil
	if err := applyCatalog(store, []CatalogModel{model}, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	if catalogProfile(t, store, model.ID)["videoPricing"] != nil {
		t.Fatal("missing current price retained a stale quote")
	}
}

func TestPortraitQuoteRejectsInvalidRates(t *testing.T) {
	for _, raw := range []string{
		`{"currency":"USD","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`,
		`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":0,"reference_video":42}}}`,
		`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69}}}`,
	} {
		if _, ok := NormalizeCatalogVideoPricing(json.RawMessage(raw)); ok {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestVideoReferenceInvoiceQuoteSurvivesCatalogRefresh(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	item := CatalogModel{ID: "minimax-h3-max-turbo", VideoPricing: json.RawMessage(`{"currency":"CNY","mode":"seconds","rates":{"768p":{"output":0.25,"reference_video":0}},"reference_invoice":{"usd_cny":7.2,"reserve_usd":5,"token":"private"}}`)}
	if err := applyCatalog(store, []CatalogModel{item}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	price := catalogProfile(t, store, item.ID)["videoPricing"].(map[string]any)
	invoice, ok := price["reference_invoice"].(map[string]any)
	if !ok || invoice["usd_cny"] != 7.2 || invoice["reserve_usd"] != float64(5) || len(invoice) != 2 {
		t.Fatalf("invoice quote lost: %#v", price)
	}
	for _, raw := range []string{
		`{"currency":"CNY","mode":"seconds","rates":{"768p":{"output":0.25,"reference_video":0}},"reference_invoice":{"usd_cny":7.2,"reserve_usd":0}}`,
		`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":20,"reference_video":12}},"reference_invoice":{"usd_cny":7.2,"reserve_usd":5}}`,
	} {
		if _, ok := NormalizeCatalogVideoPricing(json.RawMessage(raw)); ok {
			t.Fatalf("accepted invalid invoice: %s", raw)
		}
	}
}

func TestPortraitRemovedFromCatalogDoesNotRetainQuoteOrAvailability(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	portrait := CatalogModel{ID: "seedance-2.0-portrait", VideoPricing: json.RawMessage(`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`)}
	if err := applyCatalog(store, []CatalogModel{portrait}, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, []CatalogModel{{ID: "seedance-2.0"}}, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channels, _ := effective.Config["channels"].([]any)
	for _, raw := range channels {
		channel, _ := raw.(map[string]any)
		if channel["id"] != ChannelID {
			continue
		}
		models, _ := channel["models"].([]any)
		for _, model := range models {
			if model == portrait.ID {
				t.Fatal("removed portrait is still available")
			}
		}
		profiles, _ := channel["modelProfiles"].([]any)
		for _, rawProfile := range profiles {
			profile, _ := rawProfile.(map[string]any)
			if profile["model"] == portrait.ID {
				t.Fatal("removed portrait retains a stale profile/quote")
			}
		}
	}
}
