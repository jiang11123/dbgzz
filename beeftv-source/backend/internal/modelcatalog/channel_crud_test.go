package modelcatalog

import (
	"fmt"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func testIDGen(prefix string) (string, error) {
	return prefix + "-1", nil
}

func TestSelectCatalogModels(t *testing.T) {
	chosen, err := SelectCatalogModels([]string{" models/b ", "a", "B"}, []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if len(chosen) != 2 || chosen[0] != "b" || chosen[1] != "a" {
		t.Fatalf("chosen = %#v", chosen)
	}
	if _, err := SelectCatalogModels(nil, []string{"a"}); err == nil {
		t.Fatal("empty selection accepted")
	}
	if _, err := SelectCatalogModels([]string{"missing"}, []string{"a"}); err == nil {
		t.Fatal("unknown catalog name accepted")
	}
}

func TestMissingFetchedAndImportedChannelModels(t *testing.T) {
	existing := []model.ChannelModel{
		{ModelKey: "kept", ProviderModelKey: "kept-up"},
		{ModelKey: "alias", ProviderModelKey: "upstream-sku"},
	}
	retired := map[string]bool{"old": true}
	ids := 0
	next := func(prefix string) (string, error) {
		ids++
		return fmt.Sprintf("%s-%d", prefix, ids), nil
	}
	fetched, err := MissingFetchedChannelModels("ch1", []string{"kept", "old", "new"}, existing, retired, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched) != 1 || fetched[0].ModelKey != "new" || fetched[0].ProviderModelKey != "new" {
		t.Fatalf("fetched = %#v", fetched)
	}
	imported, err := MissingImportedChannelModels("ch1", []string{"upstream-sku", "fresh"}, existing, retired, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(imported) != 1 || imported[0].ModelKey != "fresh" || imported[0].ProviderModelKey != "" {
		t.Fatalf("imported = %#v", imported)
	}
}

func TestPlanInitialChannelModelSync(t *testing.T) {
	channel := model.ModelChannel{ID: "ch1", RetiredModelsJSON: `["retired"]`}
	existing := []model.ChannelModel{
		{ID: "keep", ChannelID: "ch1", ModelKey: "keep", Enabled: true},
		{ID: "drop", ChannelID: "ch1", ModelKey: "drop", Enabled: true},
		{ID: "already", ChannelID: "ch1", ModelKey: "already-off", Enabled: false},
	}
	plan, err := PlanInitialChannelModelSync(channel, []string{"keep", "models/new", "retired"}, existing, testIDGen)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Create) != 1 || plan.Create[0].ModelKey != "new" || plan.Create[0].Enabled {
		t.Fatalf("create = %#v", plan.Create)
	}
	if len(plan.Disable) != 1 || plan.Disable[0].ID != "drop" || plan.Disable[0].Enabled {
		t.Fatalf("disable = %#v", plan.Disable)
	}
}

func TestValidateChannelModelDeleteSelection(t *testing.T) {
	items := []model.ChannelModel{{ID: "a"}, {ID: "b"}}
	if err := ValidateChannelModelDeleteSelection([]string{"a", "b"}, items); err != nil {
		t.Fatal(err)
	}
	if err := ValidateChannelModelDeleteSelection([]string{"a", "missing"}, items); err == nil {
		t.Fatal("missing id accepted")
	}
}

func TestPrepareChannelModelSaveCreate(t *testing.T) {
	enabled := true
	item, tiers, err := PrepareChannelModelSave("ch1", "", ChannelModelRequest{
		ModelKey: "gpt", DisplayName: "GPT", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "gpt"),
		Enabled:          &enabled,
	}, "gpt", "gpt", "text", model.ChannelInterfaceChatCompletion, nil, testIDGen)
	if err != nil {
		t.Fatal(err)
	}
	if item.ID == "" || item.ChannelID != "ch1" || item.ModelKey != "gpt" || !item.Enabled {
		t.Fatalf("item = %#v", item)
	}
	if len(tiers) != 1 || tiers[0].ID == "" {
		t.Fatalf("tiers = %#v", tiers)
	}
}

func TestDuplicateSystemChannelModels(t *testing.T) {
	source := model.ModelChannel{ID: "src", Name: "系统", APIKey: "k"}
	models := []model.ChannelModel{{
		ID: "m1", ChannelID: "src", ModelKey: "gpt", Enabled: true,
		Variants: []model.ChannelModelVariant{{ID: "v1", ProviderModelKey: "gpt"}},
	}}
	ids := 0
	next := func(prefix string) (string, error) {
		ids++
		return fmt.Sprintf("%s-%d", prefix, ids), nil
	}
	channel, copies, variants, err := DuplicateSystemChannelModels(source, models, "admin", "CHANNEL-1", next)
	if err != nil {
		t.Fatal(err)
	}
	if channel.ID != "CHANNEL-1" || channel.UserID != "admin" || channel.Name != "系统 - 副本" {
		t.Fatalf("channel = %#v", channel)
	}
	if len(copies) != 1 || copies[0].ID == "m1" || copies[0].ChannelID != "CHANNEL-1" {
		t.Fatalf("copies = %#v", copies)
	}
	if len(variants) != 1 || variants[0].ChannelModelID != copies[0].ID {
		t.Fatalf("variants = %#v", variants)
	}
}
