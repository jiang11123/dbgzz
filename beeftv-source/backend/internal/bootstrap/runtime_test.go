package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"testing"
	"time"

	"infinite-canvas/backend/internal/workspace"
)

// This catches lifecycle regressions where the embedded backend cannot bind a
// loopback port, report readiness, or release its resources cleanly.
func TestRuntimeOpenStartClose(t *testing.T) {
	runtime, err := Open(context.Background(), Config{
		Profile:         ProfileDesktop,
		DataDir:         t.TempDir(),
		ListenAddr:      "127.0.0.1:0",
		AutoMigrate:     true,
		ShutdownTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.localApp == nil {
		t.Fatal("desktop runtime must be owned by the local composition root")
	}
	if _, ok := runtime.localApp.ProviderConfig.(*workspace.ProviderConfig); !ok {
		t.Fatal("desktop provider config must use the independent workspace store")
	}
	if err := runtime.Start(); err != nil {
		t.Fatal(err)
	}
	if !runtime.Ready() {
		t.Fatal("runtime must be ready after Start")
	}
	if runtime.BaseURL() == "" || runtime.LaunchToken() == "" {
		t.Fatalf("desktop transport not initialized: baseURL=%q token=%q", runtime.BaseURL(), runtime.LaunchToken())
	}

	request, err := http.NewRequest(http.MethodGet, runtime.BaseURL()+"/health/ready", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Desktop-Token", runtime.LaunchToken())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("ready status = %d, want %d", response.StatusCode, http.StatusOK)
	}

	bootstrapRequest, err := http.NewRequest(http.MethodGet, runtime.BaseURL()+"/workspace/bootstrap", nil)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapRequest.Header.Set("X-Desktop-Token", runtime.LaunchToken())
	bootstrapResponse, err := http.DefaultClient.Do(bootstrapRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer bootstrapResponse.Body.Close()
	if bootstrapResponse.StatusCode != http.StatusOK {
		t.Fatalf("workspace bootstrap status = %d, want %d", bootstrapResponse.StatusCode, http.StatusOK)
	}
	var bootstrapEnvelope struct {
		Data struct {
			ContractVersion int    `json:"contractVersion"`
			Profile         string `json:"profile"`
			Capabilities    struct {
				Auth            bool `json:"auth"`
				Billing         bool `json:"billing"`
				CloudStorage    bool `json:"cloudStorage"`
				RemoteSync      bool `json:"remoteSync"`
				RemoteSkillSync bool `json:"remoteSkillSync"`
				LocalAssets     bool `json:"localAssets"`
				ProviderCalls   bool `json:"providerCalls"`
			} `json:"capabilities"`
			Workspace struct {
				ID      string `json:"id"`
				Storage string `json:"storage"`
			} `json:"workspace"`
			User struct {
				Username string `json:"username"`
			} `json:"user"`
			LogicalModels []json.RawMessage `json:"logicalModels"`
		} `json:"data"`
	}
	if err := json.NewDecoder(bootstrapResponse.Body).Decode(&bootstrapEnvelope); err != nil {
		t.Fatal(err)
	}
	if bootstrapEnvelope.Data.Workspace.ID == "" || bootstrapEnvelope.Data.Workspace.Storage != "sqlite" || bootstrapEnvelope.Data.User.Username != "local" {
		t.Fatalf("unexpected workspace bootstrap payload: %#v", bootstrapEnvelope)
	}
	if len(bootstrapEnvelope.Data.LogicalModels) != 0 {
		t.Fatalf("local bootstrap must not expose hosted logical models: %d", len(bootstrapEnvelope.Data.LogicalModels))
	}
	if bootstrapEnvelope.Data.ContractVersion != 1 || bootstrapEnvelope.Data.Profile != "local" {
		t.Fatalf("unexpected desktop contract identity: version=%d profile=%q", bootstrapEnvelope.Data.ContractVersion, bootstrapEnvelope.Data.Profile)
	}
	capabilities := bootstrapEnvelope.Data.Capabilities
	if !capabilities.LocalAssets || !capabilities.ProviderCalls || capabilities.Auth || capabilities.Billing || capabilities.CloudStorage || capabilities.RemoteSync || capabilities.RemoteSkillSync {
		t.Fatalf("unexpected desktop capabilities: %#v", capabilities)
	}
	if cookie := bootstrapResponse.Header.Get("Set-Cookie"); cookie != "" {
		t.Fatalf("workspace bootstrap must not set a session cookie: %q", cookie)
	}

	tasksRequest, err := http.NewRequest(http.MethodGet, runtime.BaseURL()+"/tasks?pageSize=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	tasksRequest.Header.Set("X-Desktop-Token", runtime.LaunchToken())
	tasksResponse, err := http.DefaultClient.Do(tasksRequest)
	if err != nil {
		t.Fatal(err)
	}
	_ = tasksResponse.Body.Close()
	if tasksResponse.StatusCode != http.StatusOK {
		t.Fatalf("desktop tasks status = %d, want %d", tasksResponse.StatusCode, http.StatusOK)
	}
	if cookie := tasksResponse.Header.Get("Set-Cookie"); cookie != "" {
		t.Fatalf("desktop tasks must not set a session cookie: %q", cookie)
	}

	preflight, err := http.NewRequest(http.MethodOptions, runtime.BaseURL()+"/auth/session", nil)
	if err != nil {
		t.Fatal(err)
	}
	preflight.Header.Set("Origin", "wails://wails")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	preflight.Header.Set("Access-Control-Request-Headers", "X-Desktop-Token")
	preflightResponse, err := http.DefaultClient.Do(preflight)
	if err != nil {
		t.Fatal(err)
	}
	_ = preflightResponse.Body.Close()
	if got := preflightResponse.Header.Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}

	legacyAuthRequest, err := http.NewRequest(http.MethodGet, runtime.BaseURL()+"/auth/session", nil)
	if err != nil {
		t.Fatal(err)
	}
	legacyAuthRequest.Header.Set("X-Desktop-Token", runtime.LaunchToken())
	legacyAuthResponse, err := http.DefaultClient.Do(legacyAuthRequest)
	if err != nil {
		t.Fatal(err)
	}
	_ = legacyAuthResponse.Body.Close()
	if legacyAuthResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("desktop auth session status = %d, want %d", legacyAuthResponse.StatusCode, http.StatusNotFound)
	}

	for _, hostedPath := range []string{
		"/oauth/linuxdo/callback",
		"/payments/orders",
		"/finance/account",
		"/resources/import",
		"/resources/demo/oss-url",
	} {
		hostedRequest, err := http.NewRequest(http.MethodGet, runtime.BaseURL()+hostedPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		hostedRequest.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		hostedResponse, err := http.DefaultClient.Do(hostedRequest)
		if err != nil {
			t.Fatal(err)
		}
		_ = hostedResponse.Body.Close()
		if hostedResponse.StatusCode != http.StatusNotFound {
			t.Fatalf("desktop hosted route %s status = %d, want %d", hostedPath, hostedResponse.StatusCode, http.StatusNotFound)
		}
	}

	unknownProxyRequest, err := http.NewRequest(http.MethodPost, runtime.BaseURL()+"/stale-channel/v1/images/generations", nil)
	if err != nil {
		t.Fatal(err)
	}
	unknownProxyRequest.Header.Set("X-Desktop-Token", runtime.LaunchToken())
	unknownProxyResponse, err := http.DefaultClient.Do(unknownProxyRequest)
	if err != nil {
		t.Fatal(err)
	}
	_ = unknownProxyResponse.Body.Close()
	if unknownProxyResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("desktop unknown proxy path status = %d, want %d", unknownProxyResponse.StatusCode, http.StatusNotFound)
	}

	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.Ready() {
		t.Fatal("runtime must not remain ready after Close")
	}
}

func TestDesktopLocalResourceAndProjectSurviveRestart(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: dataDir, ListenAddr: "127.0.0.1:0", AutoMigrate: true, ShutdownTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatal(err)
	}

	request := func(method, path string, body io.Reader, contentType string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, runtime.BaseURL()+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	projectResponse := request(http.MethodPost, "/projects", bytes.NewBufferString(`{"name":"本地验收项目"}`), "application/json")
	var projectEnvelope struct {
		Data struct {
			Project struct {
				ID string `json:"id"`
			} `json:"project"`
		} `json:"data"`
	}
	if projectResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(projectResponse.Body)
		_ = projectResponse.Body.Close()
		t.Fatalf("create project status = %d, body=%s", projectResponse.StatusCode, body)
	}
	if err := json.NewDecoder(projectResponse.Body).Decode(&projectEnvelope); err != nil {
		_ = projectResponse.Body.Close()
		t.Fatal(err)
	}
	_ = projectResponse.Body.Close()
	if projectEnvelope.Data.Project.ID == "" {
		t.Fatal("local project id is empty")
	}

	var uploadBody bytes.Buffer
	writer := multipart.NewWriter(&uploadBody)
	partHeader := make(textproto.MIMEHeader)
	partHeader.Set("Content-Disposition", `form-data; name="file"; filename="local.txt"`)
	partHeader.Set("Content-Type", "text/plain")
	part, err := writer.CreatePart(partHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("beeftv-local-resource")); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("kind", "document"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	resourceResponse := request(http.MethodPost, "/resources", &uploadBody, writer.FormDataContentType())
	var resourceEnvelope struct {
		Data struct {
			Resource struct {
				ID       string `json:"id"`
				Provider string `json:"provider"`
			} `json:"resource"`
		} `json:"data"`
	}
	if resourceResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resourceResponse.Body)
		_ = resourceResponse.Body.Close()
		t.Fatalf("local resource status = %d, body=%s", resourceResponse.StatusCode, body)
	}
	if err := json.NewDecoder(resourceResponse.Body).Decode(&resourceEnvelope); err != nil {
		_ = resourceResponse.Body.Close()
		t.Fatal(err)
	}
	_ = resourceResponse.Body.Close()
	if resourceEnvelope.Data.Resource.ID == "" || resourceEnvelope.Data.Resource.Provider != "local" {
		t.Fatalf("unexpected local resource: %#v", resourceEnvelope.Data.Resource)
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	runtime, err = Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: dataDir, ListenAddr: "127.0.0.1:0", AutoMigrate: true, ShutdownTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	resourcesResponse := request(http.MethodGet, "/resources", nil, "")
	var resourcesEnvelope struct {
		Data struct {
			Resources []struct {
				ID       string `json:"id"`
				Provider string `json:"provider"`
			} `json:"resources"`
		} `json:"data"`
	}
	if resourcesResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resourcesResponse.Body)
		_ = resourcesResponse.Body.Close()
		t.Fatalf("resources after restart status = %d, body=%s", resourcesResponse.StatusCode, body)
	}
	if err := json.NewDecoder(resourcesResponse.Body).Decode(&resourcesEnvelope); err != nil {
		_ = resourcesResponse.Body.Close()
		t.Fatal(err)
	}
	_ = resourcesResponse.Body.Close()
	if len(resourcesEnvelope.Data.Resources) != 1 || resourcesEnvelope.Data.Resources[0].Provider != "local" {
		t.Fatalf("resources after restart = %#v", resourcesEnvelope.Data.Resources)
	}
	fileResponse := request(http.MethodGet, "/resources/"+resourcesEnvelope.Data.Resources[0].ID+"/file", nil, "")
	fileBody, err := io.ReadAll(fileResponse.Body)
	_ = fileResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if fileResponse.StatusCode != http.StatusOK || string(fileBody) != "beeftv-local-resource" {
		t.Fatalf("local resource body after restart: status=%d body=%q", fileResponse.StatusCode, fileBody)
	}
	projectsResponse := request(http.MethodGet, "/projects", nil, "")
	var projectsEnvelope struct {
		Data struct {
			Projects []struct {
				Project struct {
					Name string `json:"name"`
				} `json:"project"`
			} `json:"projects"`
		} `json:"data"`
	}
	if projectsResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(projectsResponse.Body)
		_ = projectsResponse.Body.Close()
		t.Fatalf("projects after restart status = %d, body=%s", projectsResponse.StatusCode, body)
	}
	if err := json.NewDecoder(projectsResponse.Body).Decode(&projectsEnvelope); err != nil {
		_ = projectsResponse.Body.Close()
		t.Fatal(err)
	}
	_ = projectsResponse.Body.Close()
	if len(projectsEnvelope.Data.Projects) != 1 || projectsEnvelope.Data.Projects[0].Project.Name != "本地验收项目" {
		t.Fatalf("projects after restart = %#v", projectsEnvelope.Data)
	}
}
