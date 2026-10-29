package operations

import (
	"encoding/json"
	"errors"
	"testing"

	"infinite-canvas/backend/internal/skillhub"
)

type marketProbe struct {
	unusedDomain
	err        error
	query      string
	page, size int
}

func (p *marketProbe) SearchSkillMarket(q string, page, size int) (*skillhub.SearchResult, error) {
	p.query, p.page, p.size = q, page, size
	return &skillhub.SearchResult{Total: 1}, p.err
}
func (p *marketProbe) GetSkillMarketRelease(id, release string) (*skillhub.Release, error) {
	return &skillhub.Release{Metadata: skillhub.Metadata{SkillID: id}, ReleaseID: release}, p.err
}
func (p *marketProbe) ReadSkillMarketFile(id, release, name string, offset, limit int) (*skillhub.FileChunk, error) {
	return &skillhub.FileChunk{File: skillhub.File{Path: name}, Offset: offset}, p.err
}

func TestSkillMarketDiscoveryOperationsAndFailureIdentity(t *testing.T) {
	r := NewRegistry(nil, nil)
	registerSkillMarketOps(r)
	p := &marketProbe{}
	ctx := &Context{UserID: "owner", Domain: p}
	for _, id := range []string{"skill.market.search", "skill.market.get", "skill.market.file"} {
		op := r.ops[id]
		if !op.ReadOnly || !op.AssistantVisible("read-only") || op.Scope != ScopeWorkspaceRead {
			t.Fatalf("discovery permissions: %+v", op)
		}
	}
	if _, err := r.ops["skill.market.search"].Handler(ctx, json.RawMessage(`{"q":"分镜"}`)); err != nil || p.query != "分镜" || p.page != 1 || p.size != 10 {
		t.Fatalf("query changed: %+v %v", p, err)
	}
	for _, params := range []string{`{"pageSize":21}`, `{"page":-1}`, `{"token":"secret"}`} {
		if _, err := r.ops["skill.market.search"].Handler(ctx, json.RawMessage(params)); err == nil {
			t.Fatalf("invalid search accepted: %s", params)
		}
	}
	if _, err := r.ops["skill.market.get"].Handler(ctx, json.RawMessage(`{"skillId":"s"}`)); err == nil {
		t.Fatal("unversioned read accepted")
	}
	value, err := r.ops["skill.market.get"].Handler(ctx, json.RawMessage(`{"skillId":"s","releaseId":"r1"}`))
	if err != nil || value.(*skillhub.Release).ReleaseID != "r1" {
		t.Fatalf("exact release lost: %v", err)
	}
	p.err = &skillhub.Error{Status: 503, Reason: "enterprise_service_not_configured", Message: "暂时不可用", RetryAfter: "30"}
	_, err = r.ops["skill.market.search"].Handler(ctx, json.RawMessage(`{}`))
	var failure *Error
	if !errors.As(err, &failure) || failure.Reason != "enterprise_service_not_configured" || failure.Details["upstreamStatus"] != 503 || failure.Details["retryAfter"] != "30" {
		t.Fatalf("failure became an empty catalog: %v", err)
	}
}
