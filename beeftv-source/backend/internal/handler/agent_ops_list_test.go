package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/operations"
)

func TestOpsListingKeepsOwnerAndExternalCatalogFull(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := agentops.EnsureOwnerToken(env.service.DataDir())
	if err != nil {
		t.Fatal(err)
	}

	ownerListing := getOps(t, env, map[string]string{"X-Beeftv-Owner": owner})
	registry := operations.NewRegistry(nil, nil)
	operations.RegisterDefaultOps(registry)
	want := make([]string, 0)
	for _, descriptor := range registry.List(operations.ManualCaller(false)) {
		want = append(want, descriptor.ID)
	}
	if !reflect.DeepEqual(ownerListing, want) {
		t.Fatalf("owner 能力发现应为 %v，得到 %v", want, ownerListing)
	}
	if !listingHas(ownerListing, "canvas.document.commit") {
		t.Fatalf("owner 应包含文档提交: %v", ownerListing)
	}
	if !listingHas(ownerListing, "asset.list") || !listingHas(ownerListing, "canvas.search") {
		t.Fatalf("owner 应包含工作区级操作: %v", ownerListing)
	}

	reg, token, err := env.clients.RegisterKind("codex", "cli", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	externalListing := getOps(t, env, map[string]string{"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token})
	if !reflect.DeepEqual(externalListing, want) {
		t.Fatalf("外部客户端能力发现应为 %v，得到 %v", want, externalListing)
	}

	hostListing := getOps(t, env, map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken})
	wantHost := make([]string, 0)
	for _, descriptor := range registry.List(operations.ManualCaller(false)) {
		if descriptor.Scope != operations.ScopeConversation {
			wantHost = append(wantHost, descriptor.ID)
		}
	}
	if !reflect.DeepEqual(hostListing, wantHost) {
		t.Fatalf("宿主回合外能力发现应为 %v，得到 %v", wantHost, hostListing)
	}
	if !listingHas(hostListing, "asset.list") || !listingHas(hostListing, "canvas.search") || !listingHas(hostListing, "canvas.document.commit") {
		t.Fatalf("宿主应能装载完整画布能力，回合内再按Go权限选择: %v", hostListing)
	}
}

func getOps(t *testing.T, env *assistantTestEnv, headers map[string]string) []string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18090/api/ops", nil)
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	env.router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET /ops = %d %s", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Data struct {
			Ops []struct {
				ID string `json:"id"`
			} `json:"ops"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(envelope.Data.Ops))
	for _, op := range envelope.Data.Ops {
		ids = append(ids, op.ID)
	}
	return ids
}

func listingHas(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}
