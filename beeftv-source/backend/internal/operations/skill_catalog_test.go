package operations

import (
	"encoding/json"
	"fmt"
	"infinite-canvas/backend/internal/skills"
	"strings"
	"testing"
)

type skillCatalogProbe struct {
	unusedDomain
	items []skills.AgentCatalogItem
}

func (p skillCatalogProbe) AgentSkillCatalog(userID string) ([]skills.AgentCatalogItem, error) {
	return p.items, nil
}

func TestSkillCatalogSearchAndExactIDReachBeyondFirstFifty(t *testing.T) {
	items := []skills.AgentCatalogItem{}
	for i := 0; i < 60; i++ {
		items = append(items, skills.AgentCatalogItem{Pin: skills.Pin{SkillID: fmt.Sprintf("skill-%02d", i), VersionID: "v1", ContentHash: strings.Repeat("a", 64)}, Name: fmt.Sprintf("skill %02d", i), Description: "fixed method"})
	}
	r := NewRegistry(nil, nil)
	registerSkillOps(r)
	ctx := &Context{UserID: "owner", Domain: skillCatalogProbe{items: items}}
	query := func(params string) map[string]any {
		t.Helper()
		result, err := r.ops["skill.catalog"].Handler(ctx, json.RawMessage(params))
		if err != nil {
			t.Fatal(err)
		}
		return result.(map[string]any)
	}
	first := query(`{}`)
	if first["total"] != 60 || len(first["skills"].([]skills.AgentCatalogItem)) != 50 {
		t.Fatalf("bad first page %+v", first)
	}
	exact := query(`{"id":"skill-59"}`)
	found := exact["skills"].([]skills.AgentCatalogItem)
	if len(found) != 1 || found[0].Pin.SkillID != "skill-59" {
		t.Fatalf("exact lookup truncated before filtering %+v", exact)
	}
	search := query(`{"q":"59"}`)
	if search["total"] != 1 {
		t.Fatalf("search failed %+v", search)
	}
	second := query(`{"offset":50,"limit":10}`)
	if len(second["skills"].([]skills.AgentCatalogItem)) != 10 {
		t.Fatalf("bad page %+v", second)
	}
	for _, params := range []string{`{"limit":51}`, `{"offset":-1}`, `{"userId":"other"}`} {
		if _, err := r.ops["skill.catalog"].Handler(ctx, json.RawMessage(params)); err == nil {
			t.Fatalf("invalid query accepted %s", params)
		}
	}
}
