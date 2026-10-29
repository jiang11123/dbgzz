package skills

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/skillhub"
)

// Opt-in integration against BeefAPI's isolated TestSkillHubLocalIntegrationServer.
// It accepts only that synthetic loopback fixture, never a real account or host.
func TestPublicationRealSkillHubCanonicalRoundTrip(t *testing.T) {
	path := os.Getenv("BEEFTV_SKILLHUB_TEST_RECEIPT")
	if path == "" {
		t.Skip("requires isolated synthetic SkillHub fixture receipt")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		BaseURL         string `json:"baseUrl"`
		PublishingToken string `json:"publishingToken"`
		FixtureOnly     bool   `json:"fixtureOnly"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	target, err := url.Parse(fixture.BaseURL)
	if err != nil {
		t.Fatal("invalid fixture URL")
	}
	ip := net.ParseIP(target.Hostname())
	if !fixture.FixtureOnly || target.Scheme != "http" || ip == nil || !ip.IsLoopback() || fixture.PublishingToken == "" {
		t.Fatal("integration requires a synthetic loopback fixture")
	}
	for _, loseResponse := range []bool{false, true} {
		name := "normal"
		if loseResponse {
			name = "lost-upload-response"
		}
		t.Run(name, func(t *testing.T) {
			s, _ := agentSkillFixture(t)
			pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Synthetic publication integration\ndescription: Text workflow contract fixture\n---\nRead references/rules.md and summarize the supplied text.", "references/rules.md": "When no text is supplied, ask for the source text."})
			plan, err := s.PublishPrepare("owner", pin.SkillID, skillhub.Metadata{License: "CC0-1.0", VersionLabel: "1.0.0"}, PublicationTarget{Kind: "new"})
			if err != nil {
				t.Fatal(err)
			}
			var creates, uploads atomic.Int32
			proxy := httputil.NewSingleHostReverseProxy(target)
			proxy.ModifyResponse = func(res *http.Response) error {
				if res.Request.Method == "POST" && strings.HasSuffix(res.Request.URL.Path, "/uploads") {
					uploads.Add(1)
					if loseResponse && res.StatusCode == http.StatusOK {
						io.Copy(io.Discard, res.Body)
						res.Body.Close()
						body := `{"success":false,"message":"synthetic loss after real fixture storage","reason":"fixture_response_loss"}`
						res.StatusCode = http.StatusBadGateway
						res.Body = io.NopCloser(strings.NewReader(body))
						res.ContentLength = int64(len(body))
						res.Header.Del("Content-Length")
					}
				}
				if res.Request.Method == "POST" && strings.HasSuffix(res.Request.URL.Path, "/submissions") {
					creates.Add(1)
				}
				return nil
			}
			server := httptest.NewServer(proxy)
			defer server.Close()
			endpoint := server.URL + "/api/beeftv/skillhub/v1"
			t.Setenv("BEEFTV_SKILLHUB_URL", endpoint)
			if err := writeMarketJSON(filepath.Join(s.marketUserDir("owner"), "authorization.json"), marketAuth{Endpoint: endpoint, AccessToken: fixture.PublishingToken, ExpiresAt: time.Now().Add(time.Minute)}); err != nil {
				t.Fatal(err)
			}
			first, err := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256)
			if loseResponse && err == nil {
				t.Fatal("lost upload response was not returned")
			}
			if !loseResponse && (err != nil || first.Status != "awaiting_submit_confirmation") {
				t.Fatal("real upload/preview failed", err)
			}
			recovered, err := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256)
			if err != nil {
				t.Fatal("real recovery failed", err)
			}
			client, err := marketClient()
			if err != nil {
				t.Fatal(err)
			}
			var remote skillhub.Draft
			if err := client.JSON(context.Background(), "GET", "submissions/"+recovered.SubmissionID, fixture.PublishingToken, "", nil, &remote); err != nil {
				t.Fatal(err)
			}
			if creates.Load() != 1 || uploads.Load() != 1 || remote.ContentHash != plan.ContentHash || remote.ArchiveSHA256 == plan.ArchiveSHA256 || recovered.ArchiveSHA256 != plan.ArchiveSHA256 || !samePublicationFiles(remote.Files, plan.Files) || recovered.Preview == nil || recovered.Metadata.SkillID == pin.SkillID || recovered.Status != "awaiting_submit_confirmation" {
				t.Fatal("real canonicalization/resume contract failed")
			}
			t.Logf("synthetic fixture: creates=%d uploads=%d localArchiveSHA=%s canonicalArchiveSHA=%s contentHash=%s previewVerified=true submitted=false", creates.Load(), uploads.Load(), plan.ArchiveSHA256, remote.ArchiveSHA256, plan.ContentHash)
		})
	}
}
