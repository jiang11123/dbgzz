package outbound

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestOutboundTransportUsesEnvironmentProxyAndHonorsNoProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://172.24.176.1:10808")
	t.Setenv("HTTPS_PROXY", "http://172.24.176.1:10808")
	t.Setenv("NO_PROXY", ".se7endot.top,100.64.0.0/10")
	transport := newOutboundTransport(resolveOutboundHost)

	proxiedRequest, _ := http.NewRequest(http.MethodGet, "https://api.mikoto.vip/v1/models", nil)
	proxyURL, err := transport.Proxy(proxiedRequest)
	if err != nil {
		t.Fatal(err)
	}
	wantProxy, _ := url.Parse("http://172.24.176.1:10808")
	if proxyURL == nil || proxyURL.String() != wantProxy.String() {
		t.Fatalf("proxy = %v, want %v", proxyURL, wantProxy)
	}

	directRequest, _ := http.NewRequest(http.MethodGet, "https://api.se7endot.top/v1/models", nil)
	proxyURL, err = transport.Proxy(directRequest)
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL != nil {
		t.Fatalf("NO_PROXY request proxy = %v, want nil", proxyURL)
	}
}

func TestConfiguredProxyHostIsTrustedAsDeploymentEgress(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://172.24.176.1:10808")
	if !configuredProxyAddress("172.24.176.1:10808") {
		t.Fatal("configuredProxyHost() rejected the configured private proxy")
	}
	if configuredProxyAddress("172.24.176.2:10808") || configuredProxyAddress("172.24.176.1:8080") {
		t.Fatal("configuredProxyHost() accepted an unrelated private host")
	}
}

func TestNormalizeOutboundHeadersAllowsCustomUserAgent(t *testing.T) {
	headers, err := NormalizeOutboundHeaders([]OutboundHeader{{Name: "user-agent", Value: "Custom Gateway/2.0"}, {Name: "X-Gateway-Tenant", Value: "tenant-a"}})
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
	ApplyOutboundHeaders(request, headers)
	ApplyDefaultOutboundHeaders(request)
	if got := request.Header.Get("User-Agent"); got != "Custom Gateway/2.0" {
		t.Fatalf("User-Agent = %q", got)
	}
	if got := request.Header.Get("X-Gateway-Tenant"); got != "tenant-a" {
		t.Fatalf("X-Gateway-Tenant = %q", got)
	}
}

func TestNormalizeOutboundHeadersRejectsUnsafeAndDuplicateValues(t *testing.T) {
	tests := [][]OutboundHeader{
		{{Name: "Authorization", Value: "Bearer attacker"}},
		{{Name: "X-Test", Value: "safe\r\ninjected: true"}},
		{{Name: "X-Test", Value: "one"}, {Name: "x-test", Value: "two"}},
	}
	for _, headers := range tests {
		if _, err := NormalizeOutboundHeaders(headers); err == nil {
			t.Fatalf("NormalizeOutboundHeaders(%#v) should fail", headers)
		}
	}
}

func TestDecodeRelayOutboundHeaders(t *testing.T) {
	raw := base64.StdEncoding.EncodeToString([]byte(`[{"name":"User-Agent","value":"Relay Agent"}]`))
	headers, err := DecodeRelayOutboundHeaders(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(headers) != 1 || headers[0].Name != "User-Agent" || headers[0].Value != "Relay Agent" {
		t.Fatalf("DecodeRelayOutboundHeaders() = %#v", headers)
	}
}

func TestApplyDefaultOutboundHeaders(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	ApplyDefaultOutboundHeaders(request)
	if got := request.Header.Get("User-Agent"); got != DefaultOutboundUserAgent {
		t.Fatalf("User-Agent = %q, want %q", got, DefaultOutboundUserAgent)
	}

	request.Header.Set("User-Agent", "custom-agent")
	ApplyDefaultOutboundHeaders(request)
	if got := request.Header.Get("User-Agent"); got != "custom-agent" {
		t.Fatalf("custom User-Agent = %q", got)
	}
}

func TestValidateOutboundURLRejectsPrivateHosts(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	for _, rawURL := range []string{"http://127.0.0.1:8080", "http://localhost:8080", "http://169.254.169.254/latest/meta-data"} {
		if _, err := ValidateOutboundURL(rawURL); err == nil {
			t.Fatalf("ValidateOutboundURL(%q) should fail", rawURL)
		}
	}
}

func TestValidateOutboundURLAllowsExplicitPrivateUpstreamOverride(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	if _, err := ValidateOutboundURL("http://127.0.0.1:8080"); err != nil {
		t.Fatalf("ValidateOutboundURL() error = %v", err)
	}
}

func TestValidateOutboundURLAllowsOnlyNamedPrivateUpstream(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	if _, err := ValidateOutboundURL("http://127.0.0.1:8080"); err != nil {
		t.Fatalf("ValidateOutboundURL() error = %v", err)
	}
	if _, err := ValidateOutboundURL("http://127.0.0.2:8080"); err == nil {
		t.Fatal("ValidateOutboundURL() should reject an unlisted private host")
	}
}

func TestAllowedPrivateUpstreamHostUsesExactCaseInsensitiveMatch(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", " API.EXAMPLE.COM.,trusted.internal ")
	if !AllowedPrivateUpstreamHost("api.example.com") {
		t.Fatal("AllowedPrivateUpstreamHost() should allow exact normalized hostname")
	}
	if AllowedPrivateUpstreamHost("api.example.com.evil.test") {
		t.Fatal("AllowedPrivateUpstreamHost() should reject hostname suffix confusion")
	}
}

func TestValidateOutboundURLAllowsLocalAndPrivateHostsByDefault(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	for _, rawURL := range []string{
		"http://127.0.0.1:8080/v1/models",
		"http://localhost:11434/v1/models",
		"http://192.168.1.100:8000/v1/models",
		"http://10.0.0.5:8080/v1/models",
		"http://172.16.0.2:8080/v1/models",
	} {
		if _, err := ValidateOutboundURL(rawURL); err != nil {
			t.Fatalf("ValidateOutboundURL(%q) error = %v", rawURL, err)
		}
		if _, err := ValidateCustomRelayURL(rawURL); err != nil {
			t.Fatalf("ValidateCustomRelayURL(%q) error = %v", rawURL, err)
		}
	}
	if _, err := ValidateOutboundURL("http://169.254.169.254/latest/meta-data"); err == nil {
		t.Fatal("ValidateOutboundURL() should still reject link-local metadata addresses by default")
	}
}

func TestValidateOutboundURLRejectsLinkLocalEvenWhenAllowlisted(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "169.254.169.254,169.254.169.254.")
	for _, rawURL := range []string{
		"http://169.254.169.254/latest/meta-data",
		"https://169.254.169.254/latest/meta-data/",
	} {
		if _, err := ValidateOutboundURL(rawURL); err == nil {
			t.Fatalf("ValidateOutboundURL(%q) should reject allowlisted link-local metadata", rawURL)
		}
		if _, err := ValidateCustomRelayURL(rawURL); err == nil {
			t.Fatalf("ValidateCustomRelayURL(%q) should reject allowlisted link-local metadata", rawURL)
		}
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	if _, err := ValidateOutboundURL("http://169.254.169.254/latest/meta-data"); err == nil {
		t.Fatal("default private upstreams must still reject metadata")
	}
}

func TestValidateCustomRelayURLRespectsPrivateUpstreamDisableAndAllowlist(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	if _, err := ValidateCustomRelayURL("http://127.0.0.1:8080/v1/models"); err == nil {
		t.Fatal("ValidateCustomRelayURL() should reject HTTP when private upstreams are disabled")
	}
	if _, err := ValidateCustomRelayURL("https://127.0.0.1:8080/v1/models"); err == nil {
		t.Fatal("ValidateCustomRelayURL() should reject private host when private upstreams are disabled")
	}
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, rawURL := range []string{
		"http://127.0.0.1:8080/v1/models",
		"https://127.0.0.1:8080/v1/models",
	} {
		if _, err := ValidateCustomRelayURL(rawURL); err != nil {
			t.Fatalf("ValidateCustomRelayURL(%q) error = %v", rawURL, err)
		}
	}
}

func TestValidateCustomRelayURLRejectsCredentialsAndFragment(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, rawURL := range []string{
		"https://user:pass@127.0.0.1/v1/models",
		"https://127.0.0.1/v1/models#secret",
	} {
		if _, err := ValidateCustomRelayURL(rawURL); err == nil {
			t.Fatalf("ValidateCustomRelayURL(%q) should fail", rawURL)
		}
	}
}

func TestBlockedCustomRelayIPRejectsCarrierGradeNATAndReservedRanges(t *testing.T) {
	for _, value := range []string{"100.100.100.200", "192.0.2.10", "198.18.0.1", "2001:db8::1"} {
		if !blockedCustomRelayIP(net.ParseIP(value)) {
			t.Fatalf("blockedCustomRelayIP(%q) = false", value)
		}
	}
	if blockedCustomRelayIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("blockedCustomRelayIP() rejected a public address")
	}
}

func TestCustomRelayHTTPClientDoesNotFollowRedirects(t *testing.T) {
	redirected := false
	destination := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirected = true
	}))
	defer destination.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", destination.URL)
		w.WriteHeader(http.StatusFound)
	}))
	defer source.Close()

	client := CustomRelayHTTPClient(time.Second)
	client.Transport = source.Client().Transport
	if _, err := client.Get(source.URL); err == nil {
		t.Fatal("CustomRelayHTTPClient() should reject redirects")
	}
	if redirected {
		t.Fatal("redirect destination should not receive the request")
	}
}

func TestAddressesAllowLocalHTTPRequiresEveryAddress(t *testing.T) {
	local := []net.IP{
		net.ParseIP("127.0.0.1"),
		net.ParseIP("::1"),
		net.ParseIP("10.1.2.3"),
		net.ParseIP("172.16.0.2"),
		net.ParseIP("192.168.1.9"),
		net.ParseIP("100.64.0.1"),
		net.ParseIP("fd00::1"),
		net.ParseIP("::ffff:10.1.2.3"),
		net.ParseIP("::ffff:100.64.1.1"),
	}
	if !addressesAllowLocalHTTP(local, true) {
		t.Fatal("loopback, RFC1918/ULA, and CGNAT should allow local HTTP")
	}
	for _, blocked := range []net.IP{
		net.ParseIP("1.1.1.1"),
		net.ParseIP("169.254.169.254"),
		net.ParseIP("::ffff:169.254.169.254"),
		net.ParseIP("198.18.0.1"),
		net.ParseIP("0.0.0.0"),
		net.ParseIP("224.0.0.1"),
		nil,
	} {
		if addressesAllowLocalHTTP([]net.IP{blocked}, true) {
			t.Fatalf("local HTTP accepted %v", blocked)
		}
	}
	if addressesAllowLocalHTTP([]net.IP{net.ParseIP("10.0.0.1"), net.ParseIP("1.1.1.1")}, true) {
		t.Fatal("a mixed public address must reject local HTTP")
	}
	if addressesAllowLocalHTTP([]net.IP{net.ParseIP("127.0.0.1")}, false) {
		t.Fatal("strict mode must reject local HTTP")
	}
	if addressesAllowLocalHTTP(nil, true) {
		t.Fatal("empty resolution must reject local HTTP")
	}
}

func TestHostAllowsLocalHTTP(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, host := range []string{"127.0.0.1", "::1", "10.0.0.8", "100.64.12.1", "192.168.0.2"} {
		if !HostAllowsLocalHTTP(context.Background(), host) {
			t.Fatalf("HostAllowsLocalHTTP(%q) = false", host)
		}
	}
	for _, host := range []string{"1.1.1.1", "169.254.169.254", "198.18.0.1", ""} {
		if HostAllowsLocalHTTP(context.Background(), host) {
			t.Fatalf("HostAllowsLocalHTTP(%q) = true", host)
		}
	}
	if _, err := ValidateOutboundURL("http://user:secret@10.0.0.8/object"); err == nil {
		t.Fatal("credential-in-URL must stay rejected")
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	if HostAllowsLocalHTTP(context.Background(), "127.0.0.1") {
		t.Fatal("allowlist must not enable local HTTP while private upstreams are locked")
	}
}
