package beefapi

import (
	"testing"
)

func TestCanonicalOriginDefaultsToProduction(t *testing.T) {
	t.Setenv(TestOriginEnv, "")
	origin, err := CanonicalOrigin("")
	if err != nil {
		t.Fatal(err)
	}
	if origin != ProductionOrigin {
		t.Fatalf("origin = %q", origin)
	}
}

func TestCanonicalOriginRejectsPublicTestOverride(t *testing.T) {
	t.Setenv(TestOriginEnv, "https://evil.example")
	if _, err := CanonicalOrigin(""); err == nil {
		t.Fatal("public override must be rejected")
	}
}

func TestCanonicalOriginAllowsLoopback(t *testing.T) {
	origin, err := CanonicalOrigin("http://127.0.0.1:8765")
	if err != nil {
		t.Fatal(err)
	}
	if origin != "http://127.0.0.1:8765" {
		t.Fatalf("origin = %q", origin)
	}
}

func TestCanonicalOriginAllowsEnterpriseLocalhostPreview(t *testing.T) {
	origin, err := CanonicalOrigin("http://enterprise.localhost:35184")
	if err != nil {
		t.Fatal(err)
	}
	if origin != "http://enterprise.localhost:35184" {
		t.Fatalf("origin = %q", origin)
	}
	t.Setenv(TestOriginEnv, "http://enterprise.localhost:35184")
	fromEnv, err := CanonicalOrigin("")
	if err != nil || fromEnv != "http://enterprise.localhost:35184" {
		t.Fatalf("env origin = %q err=%v", fromEnv, err)
	}
}

func TestCanonicalOriginRejectsLookalikePreviewHosts(t *testing.T) {
	for _, raw := range []string{
		"http://enterprise.localhost.evil.com",
		"http://evil.enterprise.localhost",
		"https://example.com",
		"http://10.0.0.8:35184",
	} {
		if _, err := CanonicalOrigin(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestWalletURLIsConsoleTopup(t *testing.T) {
	origin := "http://enterprise.localhost:35184"
	if WalletURL(origin) != origin+"/console/topup" {
		t.Fatalf("wallet = %q", WalletURL(origin))
	}
	if _, err := ValidateWalletURL(origin, origin+"/console/topup"); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateWalletURL(origin, origin+"/"); err == nil {
		t.Fatal("home page must not be a wallet URL")
	}
	if _, err := ValidateWalletURL(origin, origin+"/wallet"); err == nil {
		t.Fatal("speculative /wallet must be rejected")
	}
}

func TestValidateVerificationURLRejectsOtherHosts(t *testing.T) {
	if _, err := ValidateVerificationURL(ProductionOrigin, "https://example.com/desktop-auth"); err == nil {
		t.Fatal("expected host mismatch")
	}
	if _, err := ValidateVerificationURL(ProductionOrigin, ProductionOrigin+"/login"); err == nil {
		t.Fatal("expected path mismatch")
	}
	if _, err := ValidateVerificationURL(ProductionOrigin, ProductionOrigin+"/desktop-auth?user_code=ABCD"); err != nil {
		t.Fatal(err)
	}
}

func TestValidateReturnedBaseURLRequiresCanonicalV1(t *testing.T) {
	if err := ValidateReturnedBaseURL(ProductionOrigin, ProductionOrigin+"/v1"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReturnedBaseURL(ProductionOrigin, ProductionOrigin+"/v1/"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReturnedBaseURL(ProductionOrigin, ProductionOrigin+"/v1/v1"); err == nil {
		t.Fatal("double /v1 must be rejected")
	}
}
