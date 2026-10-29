package modelcatalog

import (
	"context"
	"errors"
	"testing"
)

func TestParseChannelModelCatalogOpenAIAndGemini(t *testing.T) {
	openAI := []byte(`{"data":[{"id":"models/b"},{"id":"a","display_name":"A","model_type":"image"}]}`)
	items, err := ParseChannelModelCatalog(openAI, "openai")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].ID != "a" || items[1].ID != "b" || items[0].DisplayName != "A" || items[0].ModelType != "image" {
		t.Fatalf("openai catalog = %#v", items)
	}
	gemini := []byte(`{"models":[{"name":"models/gemini-pro"}]}`)
	items, err = ParseChannelModelCatalog(gemini, "gemini")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != "gemini-pro" {
		t.Fatalf("gemini catalog = %#v", items)
	}
}

func TestParseChannelModelCatalogRejectsInvalidJSONAndUpstreamError(t *testing.T) {
	if _, err := ParseChannelModelCatalog([]byte(`{"message":"ok"}`), "openai"); err == nil {
		t.Fatal("unexpected JSON schema accepted as an empty model list")
	}
	if _, err := ParseChannelModelCatalog([]byte("not-json"), "openai"); err == nil {
		t.Fatal("invalid json accepted")
	}
	if _, err := ParseChannelModelCatalog([]byte(`{"error":{"message":"nope"}}`), "openai"); err == nil {
		t.Fatal("upstream error accepted")
	}
	if _, err := ParseChannelModelCatalog([]byte(`{"code":1}`), "openai"); err == nil {
		t.Fatal("nonzero code accepted")
	}
}

func TestValidateCatalogRequest(t *testing.T) {
	if _, _, _, err := ValidateCatalogRequest("", "k", ""); err == nil {
		t.Fatal("empty url accepted")
	}
	if _, _, _, err := ValidateCatalogRequest("https://example.com/v1", "", ""); err == nil {
		t.Fatal("empty key accepted")
	}
	if _, _, _, err := ValidateCatalogRequest("https://example.com/v1", "k", "claude"); err == nil {
		t.Fatal("unsupported format accepted")
	}
	base, key, format, err := ValidateCatalogRequest(" https://example.com/v1/ ", " k ", "")
	if err != nil || base != "https://example.com/v1" || key != "k" || format != "openai" {
		t.Fatalf("normalized = %q %q %q %v", base, key, format, err)
	}
}

func TestLoadChannelModelCatalogUsesFetcher(t *testing.T) {
	called := false
	items, err := LoadChannelModelCatalog(context.Background(), func(ctx context.Context, baseURL, apiFormat, apiKey string, headers []ChannelHeader) ([]byte, error) {
		called = true
		if baseURL != "https://example.com/v1" || apiFormat != "openai" || apiKey != "k" {
			t.Fatalf("fetcher args = %q %q %q", baseURL, apiFormat, apiKey)
		}
		return []byte(`{"data":[{"id":"m1"}]}`), nil
	}, "https://example.com/v1", "openai", "k", nil, nil)
	if err != nil || !called || len(items) != 1 || items[0].ID != "m1" {
		t.Fatalf("load = %#v %v called=%v", items, err, called)
	}
	_, err = LoadChannelModelCatalog(context.Background(), func(context.Context, string, string, string, []ChannelHeader) ([]byte, error) {
		return nil, CatalogFetchError{StatusCode: 401, Cause: errors.New("no")}
	}, "https://example.com/v1", "openai", "k", nil, nil)
	if err == nil {
		t.Fatal("fetcher error dropped")
	}
}

func TestCatalogModelIDs(t *testing.T) {
	ids := CatalogModelIDs([]ChannelModelCatalogItem{{ID: "b"}, {ID: "a"}, {ID: "a"}, {ID: ""}})
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("ids = %#v", ids)
	}
}
