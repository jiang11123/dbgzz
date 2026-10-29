package beefapi

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/workspace"
)

type fakeEnterprise struct {
	mu           sync.Mutex
	codes        int
	tokenCalls   int
	completes    int
	cancels      int
	deletes      int
	pending      atomic.Int32
	mode         string
	completeMode string
	catalogFail  bool
	models       []map[string]any
	opened       []string
}

func newEnterpriseServer(t *testing.T, fake *fakeEnterprise) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/oauth/device/token", func(w http.ResponseWriter, r *http.Request) {
		fake.tokenCalls++
		switch fake.mode {
		case "pending":
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
			return
		case "denied":
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "access_denied"})
			return
		case "expired":
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "expired_token"})
			return
		case "nomarket":
			writeNumericToken(w, r, "", "enterprise")
			return
		case "nogroup":
			writeNumericToken(w, r, "enterprise", "")
			return
		}
		if fake.pending.Add(-1) >= 0 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
			return
		}
		writeNumericToken(w, r, "enterprise", "enterprise")
	})
	mux.HandleFunc("/api/oauth/device/complete", func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		fake.completes++
		mode := fake.completeMode
		count := fake.completes
		fake.mu.Unlock()
		switch mode {
		case "never":
			w.WriteHeader(http.StatusBadGateway)
			return
		case "expired":
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "expired_token"})
			return
		case "drop":
			if count == 1 {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})
	mux.HandleFunc("/api/oauth/device/cancel", func(w http.ResponseWriter, r *http.Request) {
		fake.cancels++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})
	mux.HandleFunc("/v1/beeftv/connection", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			fake.deletes++
			w.WriteHeader(http.StatusNoContent)
			return
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasSuffix(auth, "ent-secret-key") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"market":"enterprise","token_id":9001,"key_name":"BeefTV","account":{"id":42,"username":"ender","display_name":"Ender"}}`)
	})
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		fail := fake.catalogFail
		models := fake.models
		fake.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if models == nil {
			models = []map[string]any{
				{"id": "gpt-test", "supported_endpoint_types": []string{"openai"}},
				{"id": "gpt-image-2", "supported_endpoint_types": []string{"image-generation"}},
				{"id": "seedance-test", "supported_endpoint_types": []string{"openai-video"}},
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
	})
	mux.HandleFunc("/desktop-auth", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/oauth/device/code" {
			origin := requestOrigin(r)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code": "dev-1", "user_code": "ABCD-EFGH",
				"verification_uri":          origin + "/desktop-auth",
				"verification_uri_complete": origin + "/desktop-auth?user_code=ABCD-EFGH",
				"expires_in":                60, "interval": 1,
			})
			fake.codes++
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func writeNumericToken(w http.ResponseWriter, r *http.Request, market, group string) {
	origin := requestOrigin(r)
	payload := map[string]any{
		"api_key": "ent-secret-key", "base_url": origin + "/v1",
		"key_name": "BeefTV", "token_id": 9001,
		"account": map[string]any{"id": 42, "username": "ender", "display_name": "Ender", "email": "e@example.com"},
	}
	if market != "" {
		payload["market"] = market
	}
	if group != "" {
		payload["group"] = group
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func requestOrigin(r *http.Request) string {
	return "http://" + r.Host
}

type previewRoundTripper struct {
	port string
	base http.RoundTripper
}

func (t previewRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	cloned := req.Clone(req.Context())
	if strings.EqualFold(cloned.URL.Hostname(), PreviewLocalHost) {
		cloned.URL.Host = net.JoinHostPort("127.0.0.1", t.port)
	}
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(cloned)
}

func previewClient(server *httptest.Server) (origin string, client *http.Client) {
	parsed, _ := url.Parse(server.URL)
	origin = "http://" + net.JoinHostPort(PreviewLocalHost, parsed.Port())
	base := server.Client()
	client = &http.Client{Transport: previewRoundTripper{port: parsed.Port(), base: base.Transport}, Timeout: base.Timeout}
	return origin, client
}

func testService(t *testing.T, fake *fakeEnterprise) (*Service, *workspace.ProviderConfig, string) {
	t.Helper()
	server := newEnterpriseServer(t, fake)
	origin, client := previewClient(server)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := New(Options{
		DataDir: dir, Origin: origin, Provider: store, ClientVersion: "test", Hostname: "testhost",
		HTTPClient: client,
		OpenURL: func(raw string) error {
			fake.opened = append(fake.opened, raw)
			return nil
		},
		Sleep: func(time.Duration) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close)
	return svc, store, dir
}

func waitState(t *testing.T, svc *Service, want string) Summary {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		summary := svc.Status()
		if summary.State == want {
			return summary
		}
		time.Sleep(10 * time.Millisecond)
	}
	summary := svc.Status()
	t.Fatalf("state = %q want %q error=%q", summary.State, want, summary.ErrorReason)
	return summary
}

func waitHasCredential(t *testing.T, svc *Service) Summary {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		summary := svc.Status()
		if summary.HasCredential {
			return summary
		}
		time.Sleep(10 * time.Millisecond)
	}
	summary := svc.Status()
	t.Fatalf("missing credential: %#v", summary)
	return summary
}

func TestConnectionHappyPathSavesBeforeAckAndHidesKey(t *testing.T) {
	fake := &fakeEnterprise{}
	svc, store, _ := testService(t, fake)
	summary, err := svc.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.State != StatePending || summary.UserCode != "ABCD-EFGH" {
		t.Fatalf("start summary = %#v", summary)
	}
	if len(fake.opened) != 1 || !strings.Contains(fake.opened[0], "/desktop-auth") || !strings.Contains(fake.opened[0], PreviewLocalHost) {
		t.Fatalf("opened = %#v", fake.opened)
	}
	connected := waitState(t, svc, StateConnected)
	if connected.Account == nil || connected.Account.ID.String() != "42" || connected.TokenID != "9001" || !connected.HasCredential {
		t.Fatalf("connected = %#v", connected)
	}
	if !strings.HasSuffix(connected.WalletURL, "/console/topup") {
		t.Fatalf("wallet = %q", connected.WalletURL)
	}
	if strings.Contains(mustJSON(t, connected), "ent-secret-key") {
		t.Fatal("summary leaked api key")
	}
	cred, err := svc.Resolve()
	if err != nil || cred.APIKey != "ent-secret-key" || cred.AccountID != "42" || cred.TokenID != "9001" {
		t.Fatalf("resolve = %#v err=%v", cred, err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	redacted := svc.RedactConfig(effective.Config)
	if strings.Contains(mustJSON(t, redacted), "ent-secret-key") {
		t.Fatal("model config presentation leaked key")
	}
	channel := findChannel(effective.Config["channels"].([]any), "beefapi")
	if channel["apiKey"] != "" {
		t.Fatalf("managed key stored in model config: %#v", channel["apiKey"])
	}
	if catalogSize(channel["models"]) < 2 {
		t.Fatalf("catalog not applied: %#v", channel["models"])
	}
	foundImage := false
	for _, raw := range channel["modelProfiles"].([]any) {
		profile, _ := raw.(map[string]any)
		if profile["model"] == "gpt-image-2" && profile["capability"] == "image" && profile["protocol"] == "openai-image" {
			foundImage = true
		}
	}
	if !foundImage {
		t.Fatalf("live endpoint types were not mapped: %#v", channel["modelProfiles"])
	}
	if fake.completes < 1 {
		t.Fatal("ack was not sent after save")
	}
}

func TestNumericWireIDsRoundTripTokenAndConnection(t *testing.T) {
	fake := &fakeEnterprise{}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	connected := waitState(t, svc, StateConnected)
	if connected.Account.ID.String() != "42" || connected.TokenID != "9001" {
		t.Fatalf("ui ids = %#v", connected)
	}
	view, status, err := svc.remoteConnection("ent-secret-key")
	if err != nil || status != http.StatusOK {
		t.Fatalf("connection GET status=%d err=%v", status, err)
	}
	if view.Account.ID.String() != "42" || view.TokenID.String() != "9001" {
		t.Fatalf("connection view = %#v", view)
	}
}

func TestMissingMarketIsRejectedWithoutLeakingSecret(t *testing.T) {
	fake := &fakeEnterprise{mode: "nomarket"}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	summary := waitState(t, svc, StateRejected)
	if strings.Contains(mustJSON(t, summary), "ent-secret-key") || strings.Contains(summary.ErrorReason, "ent-secret-key") {
		t.Fatalf("leaked secret: %#v", summary)
	}
	if summary.HasCredential {
		t.Fatal("rejected token must not keep a connected credential")
	}
}

func TestConnectionRejectedAndExpiredAreDistinct(t *testing.T) {
	fake := &fakeEnterprise{mode: "denied"}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	summary := waitState(t, svc, StateRejected)
	if summary.ErrorReason == "" {
		t.Fatal("rejected reason missing")
	}

	fake = &fakeEnterprise{mode: "expired"}
	svc, _, _ = testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if waitState(t, svc, StateExpired).State != StateExpired {
		t.Fatal("expired not recorded")
	}
}

func TestCancelDoesNotDuplicateRemoteEffects(t *testing.T) {
	fake := &fakeEnterprise{mode: "pending"}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fake.cancels == 0 {
		t.Fatal("cancel was not sent")
	}
	if svc.Status().State != StateCancelled {
		t.Fatalf("state = %q", svc.Status().State)
	}
}

func TestAckLostResponseRetriesInSameProcess(t *testing.T) {
	fake := &fakeEnterprise{completeMode: "drop"}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	connected := waitState(t, svc, StateConnected)
	if connected.Account.ID.String() != "42" {
		t.Fatalf("connected = %#v", connected)
	}
	if fake.completes < 2 {
		t.Fatalf("ack retries = %d", fake.completes)
	}
}

func TestAckLostResponseRecoversAfterRestart(t *testing.T) {
	fake := &fakeEnterprise{completeMode: "never"}
	svc, _, dir := testService(t, fake)
	origin := svc.Origin()
	client := svc.httpClient
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	saved := waitHasCredential(t, svc)
	if saved.State == StateConnected {
		t.Fatal("unacked key must not report connected")
	}
	onDisk, err := loadState(dir)
	if err != nil || onDisk.Device == nil || onDisk.Device.DeviceCode == "" || onDisk.Acked {
		t.Fatalf("durable recovery missing: %#v err=%v", onDisk, err)
	}
	svc.Close()
	restartDir := t.TempDir()
	copyWorkspaceFile(t, dir, restartDir, connectionStoreFile)
	copyWorkspaceFile(t, dir, restartDir, ".settings-key")
	fake.mu.Lock()
	fake.completeMode = ""
	fake.mu.Unlock()
	store, err := workspace.NewProviderConfig(restartDir)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := New(Options{
		DataDir: restartDir, Origin: origin, Provider: store, ClientVersion: "test", Hostname: "testhost",
		HTTPClient: client, OpenURL: func(string) error { return nil }, Sleep: func(time.Duration) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if err := restarted.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	connected := waitState(t, restarted, StateConnected)
	if connected.TokenID != "9001" || connected.Account.ID.String() != "42" {
		t.Fatalf("restarted = %#v", connected)
	}
}

func copyWorkspaceFile(t *testing.T, fromDir, toDir, name string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(fromDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(toDir, name), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAckNeverAcceptedDoesNotReportConnected(t *testing.T) {
	fake := &fakeEnterprise{completeMode: "never"}
	svc, _, dir := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	saved := waitHasCredential(t, svc)
	if saved.State == StateConnected {
		t.Fatal("never-acked session reported connected")
	}
	if err := svc.Recover(context.Background()); err == nil && svc.Status().State == StateConnected {
		t.Fatal("recover connected a doomed unacked key")
	}
	onDisk, err := loadState(dir)
	if err != nil || onDisk.Acked || onDisk.Device == nil || onDisk.Device.DeviceCode == "" {
		t.Fatalf("device_code dropped before ack: %#v err=%v", onDisk, err)
	}
}

func TestPermanentAckExpiryDoesNotKeepDoomedKeyConnected(t *testing.T) {
	fake := &fakeEnterprise{completeMode: "expired"}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	summary := waitState(t, svc, StateExpired)
	if summary.HasCredential || summary.State == StateConnected {
		t.Fatalf("doomed key kept: %#v", summary)
	}
	if _, err := svc.Resolve(); err == nil {
		t.Fatal("doomed key remained resolvable")
	}
}

func TestAckedSaveFailureDoesNotReportConnected(t *testing.T) {
	fake := &fakeEnterprise{}
	server := newEnterpriseServer(t, fake)
	origin, client := previewClient(server)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := New(Options{
		DataDir: dir, Origin: origin, Provider: store, ClientVersion: "test", Hostname: "testhost",
		HTTPClient: client, OpenURL: func(string) error { return nil }, Sleep: func(time.Duration) {},
		Persist: func(state persistedState) error {
			if state.Acked {
				return os.ErrPermission
			}
			return saveState(dir, state)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitHasCredential(t, svc)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if svc.Status().State == StateConnected {
			t.Fatal("acked save failure reported connected")
		}
		time.Sleep(10 * time.Millisecond)
	}
	onDisk, err := loadState(dir)
	if err != nil || onDisk.Acked || onDisk.Status == StateConnected {
		t.Fatalf("disk = %#v err=%v", onDisk, err)
	}
}

func TestCatalogFailureIsNotConnected(t *testing.T) {
	fake := &fakeEnterprise{catalogFail: true}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	summary := waitState(t, svc, StateCatalogFailed)
	if !summary.HasCredential {
		t.Fatal("credential should remain after catalog failure")
	}
	if _, err := svc.Resolve(); err != nil {
		t.Fatal(err)
	}
}

func TestDisconnectRevokesOnlyCurrentKey(t *testing.T) {
	fake := &fakeEnterprise{}
	svc, store, _ := testService(t, fake)
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"other","apiKey":"keep-me","enabled":true,"models":["x"]}]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	if _, err := svc.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fake.deletes != 1 {
		t.Fatalf("deletes = %d", fake.deletes)
	}
	if svc.Status().State != StateDisconnected || svc.HasManagedCredential() {
		t.Fatalf("status = %#v", svc.Status())
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	other := findChannel(effective.Config["channels"].([]any), "other")
	if other["apiKey"] != "keep-me" {
		t.Fatalf("unrelated channel overwritten: %#v", other)
	}
}

func TestOpenWalletUsesConsoleTopup(t *testing.T) {
	fake := &fakeEnterprise{}
	svc, _, _ := testService(t, fake)
	if err := svc.OpenWallet(); err != nil {
		t.Fatal(err)
	}
	if len(fake.opened) != 1 || !strings.HasSuffix(fake.opened[0], "/console/topup") || !strings.Contains(fake.opened[0], PreviewLocalHost) {
		t.Fatalf("opened = %#v", fake.opened)
	}
}

func TestStartDoesNotMintNewDeviceWhileCredentialExists(t *testing.T) {
	fake := &fakeEnterprise{catalogFail: true}
	svc, _, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateCatalogFailed)
	if fake.codes != 1 {
		t.Fatalf("codes after first start = %d", fake.codes)
	}
	summary, err := svc.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.State == StateConnected {
		t.Fatal("catalog failure must not report connected")
	}
	if fake.codes != 1 {
		t.Fatalf("retry minted another device code: %d", fake.codes)
	}
	if !summary.HasCredential {
		t.Fatal("saved key was discarded on retry")
	}
	fake.mu.Lock()
	fake.catalogFail = false
	fake.mu.Unlock()
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	connected := waitState(t, svc, StateConnected)
	if fake.codes != 1 {
		t.Fatalf("catalog retry minted another device: %d", fake.codes)
	}
	if !connected.HasCredential || connected.State != StateConnected {
		t.Fatalf("catalog retry did not recover: %#v", connected)
	}
}

func TestAcceptTokenReplacesCatalogAndRevokesPriorKeyOnAccountSwitch(t *testing.T) {
	fake := &fakeEnterprise{}
	svc, store, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	fake.mu.Lock()
	fake.models = []map[string]any{
		{"id": "model-b", "supported_endpoint_types": []string{"openai-video"}},
		{"id": "model-c", "supported_endpoint_types": []string{"openai"}},
	}
	fake.mu.Unlock()
	if err := svc.acceptToken(context.Background(), "dev-switch", tokenSuccess{
		APIKey: "ent-secret-key-2", BaseURL: TokenBaseURL(svc.Origin()), Market: "enterprise", Group: "enterprise",
		KeyName: "BeefTV-2", TokenID: wireID("9002"),
		Account: Account{ID: wireID("99"), Username: "other", DisplayName: "Other"},
	}); err != nil {
		t.Fatal(err)
	}
	if fake.deletes != 1 {
		t.Fatalf("previous key was not revoked: deletes=%d", fake.deletes)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channel := findChannel(effective.Config["channels"].([]any), ChannelID)
	ids := map[string]bool{}
	for _, item := range mergeModelIDs(channel["models"], nil) {
		ids[item.(string)] = true
	}
	if ids["gpt-test"] || ids["gpt-image-2"] || !ids["model-b"] || !ids["model-c"] {
		t.Fatalf("account switch kept stale models: %#v", channel["models"])
	}
	switched := svc.Status()
	if switched.Account == nil || switched.Account.ID.String() != "99" {
		t.Fatalf("account not switched: %#v", switched)
	}
}

func TestSaveStateFailureIsDistinct(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, connectionStoreFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := saveState(dir, persistedState{Status: StatePending}); err == nil {
		t.Fatal("directory collision must fail")
	}
}

func TestFrontendWriteCannotClobberManagedFields(t *testing.T) {
	incoming := map[string]any{"channels": []any{map[string]any{"id": "beefapi", "apiKey": "from-ui", "deviceCode": "leak", "models": []any{}}}}
	existing := map[string]any{"channels": []any{map[string]any{"id": "beefapi", "apiKey": "disk-secret", "models": []any{"gpt-image-2"}, "modelProfiles": []any{map[string]any{"model": "gpt-image-2", "capability": "image"}}}}}
	PreserveManagedChannel(incoming, existing, true)
	channel := findChannel(incoming["channels"].([]any), "beefapi")
	if channel["apiKey"] != "" || channel["deviceCode"] != nil {
		t.Fatalf("managed fields leaked into write: %#v", channel)
	}
	if catalogSize(channel["models"]) != 1 {
		t.Fatalf("empty frontend write dropped managed catalog: %#v", channel["models"])
	}
}

func TestPreserveManagedChannelKeepsServerInventoryAndManualProviders(t *testing.T) {
	incoming := map[string]any{"channels": []any{
		map[string]any{"id": "beefapi", "enabled": false, "apiKey": "from-ui", "models": []any{"stale-a", "stale-b"}, "modelProfiles": []any{map[string]any{"model": "stale-a"}}},
		map[string]any{"id": "manual", "name": "工作室渠道", "apiKey": "keep-me", "models": []any{"local-image"}},
	}}
	existing := map[string]any{"channels": []any{
		map[string]any{"id": "beefapi", "apiKey": "disk-secret", "baseUrl": "https://enterprise.beefapi.com", "models": []any{"enterprise-image"}, "modelProfiles": []any{map[string]any{"model": "enterprise-image", "capability": "image", "protocol": "openai-image"}}},
		map[string]any{"id": "manual", "name": "旧名称", "apiKey": "disk-manual", "models": []any{"old-image"}},
	}}
	PreserveManagedChannel(incoming, existing, true)
	beef := findChannel(incoming["channels"].([]any), "beefapi")
	manual := findChannel(incoming["channels"].([]any), "manual")
	if catalogSize(beef["models"]) != 1 || beef["models"].([]any)[0] != "enterprise-image" {
		t.Fatalf("stale nonempty inventory replaced catalog: %#v", beef["models"])
	}
	if beef["apiKey"] != "" || beef["credentialRef"] != CredentialRef || beef["enabled"] != false {
		t.Fatalf("managed credential/user fields: %#v", beef)
	}
	if beef["baseUrl"] != "https://enterprise.beefapi.com" {
		t.Fatalf("managed base URL dropped: %#v", beef["baseUrl"])
	}
	if manual["name"] != "工作室渠道" || manual["apiKey"] != "keep-me" || catalogSize(manual["models"]) != 1 {
		t.Fatalf("manual provider overwritten: %#v", manual)
	}
}

func TestPreserveManagedChannelClearsStaleInventoryAfterDisconnect(t *testing.T) {
	incoming := map[string]any{"channels": []any{map[string]any{"id": "beefapi", "models": []any{"stale-a", "stale-b"}}}}
	existing := map[string]any{"channels": []any{map[string]any{"id": "beefapi", "models": []any{}, "modelProfiles": []any{}}}}
	PreserveManagedChannel(incoming, existing, false)
	channel := findChannel(incoming["channels"].([]any), "beefapi")
	if catalogSize(channel["models"]) != 0 {
		t.Fatalf("disconnected catalog restored from stale frontend: %#v", channel["models"])
	}
}

func catalogSize(value any) int {
	switch typed := value.(type) {
	case []any:
		return len(typed)
	case []string:
		return len(typed)
	default:
		return 0
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
