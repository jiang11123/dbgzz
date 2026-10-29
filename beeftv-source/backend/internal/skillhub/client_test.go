package skillhub

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestClientRejectsUntrustedArchiveAndEncodedTraversal(t *testing.T) {
	c, e := New("https://beeftv.app/api/beeftv/skillhub/v1")
	if e != nil {
		t.Fatal(e)
	}
	for _, route := range []string{"https://evil.invalid/archive", "//evil.invalid/archive", "/api/beeftv/skillhub/v1/%2e%2e/secret", "https://beeftv.app/other-api", "../private"} {
		if _, e = c.URL(route); e == nil {
			t.Fatal("untrusted archive", route)
		}
	}
}
func TestDedicatedReleaseSignatureCannotBeChangedOrSelfTrusted(t *testing.T) {
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	r := Release{Metadata: Metadata{SkillID: "one", Name: "Original", RequirementNotes: "Text only, no paid tool required"}, ReleaseID: "r1", ArchiveSHA256: "fixed", Review: &ReviewSummary{Revision: 2, Trials: []ReviewTrial{{Scenario: "normal", Target: "beeftv", Conclusion: "Observed output"}}}}
	payload, _ := json.Marshal(r)
	r.Attestation = &Attestation{Algorithm: "Ed25519", KeyID: "market-key", Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))}
	keys, _ := json.Marshal(map[string]string{"market-key": base64.StdEncoding.EncodeToString(public)})
	t.Setenv("BEEFTV_SKILLHUB_TRUSTED_KEYS", string(keys))
	if e = VerifyRelease(&r); e != nil {
		t.Fatal(e)
	}
	r.Review.Trials[0].Conclusion = "Tampered"
	if e = VerifyRelease(&r); e == nil {
		t.Fatal("review evidence changed without rejection")
	}
	r.Review.Trials[0].Conclusion = "Observed output"
	r.RequirementNotes = "Changed requirement"
	if e = VerifyRelease(&r); e == nil {
		t.Fatal("requirements changed without rejection")
	}
	r.RequirementNotes = "Text only, no paid tool required"
	r.Name = "Changed"
	if e = VerifyRelease(&r); e == nil {
		t.Fatal("signed metadata changed without rejection")
	}
	t.Setenv("BEEFTV_SKILLHUB_TRUSTED_KEYS", `{"different-key":"ignored"}`)
	r.Name = "Original"
	if e = VerifyRelease(&r); e == nil {
		t.Fatal("catalog-supplied key became trusted")
	}
}
