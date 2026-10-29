package operations

import (
	"encoding/json"
	"testing"
)

type projectSearchProbe struct {
	unusedDomain
	calls  int
	target string
}

func (p *projectSearchProbe) SearchAgentProject(user, canvas, target, query, kind string, page, size int) (any, error) {
	p.calls++
	p.target = target
	return map[string]any{"page": page, "pageSize": size}, nil
}

func TestProjectSearchRejectsModelScopeExpansion(t *testing.T) {
	r := NewRegistry(nil, nil)
	RegisterDefaultOps(r)
	probe := &projectSearchProbe{}
	ctx := &Context{UserID: "owner", Domain: probe}
	for _, id := range []string{"project.media.search", "project.canvas.search"} {
		op := r.ops[id]
		for _, params := range []string{`{"canvasId":"c","projectId":"foreign"}`, `{"canvasId":"c","pageSize":21}`, `{"canvasId":"c","page":-1}`, `{"canvasId":"c","kind":"exe"}`, `{"canvasId":""}`} {
			if _, err := op.Handler(ctx, json.RawMessage(params)); err == nil {
				t.Fatalf("scope expansion accepted %s", params)
			}
		}
		if probe.calls != 0 {
			t.Fatal("invalid params reached domain")
		}
		if _, err := op.Handler(ctx, json.RawMessage(`{"canvasId":"c","query":"Interview"}`)); err != nil {
			t.Fatal(err)
		}
		probe.calls = 0
	}
}
