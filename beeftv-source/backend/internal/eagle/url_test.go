package eagle

import (
	"strings"
	"testing"
)

func TestValidateBaseURLAcceptsLoopback41595(t *testing.T) {
	for _, raw := range []string{"", "http://127.0.0.1:41595", "http://localhost:41595", "http://[::1]:41595", " http://127.0.0.1:41595/ "} {
		parsed, err := validateBaseURL(raw)
		if err != nil {
			t.Fatalf("validateBaseURL(%q) = %v", raw, err)
		}
		if parsed.Scheme != "http" || parsed.Port() != "41595" {
			t.Fatalf("validateBaseURL(%q) = %s", raw, parsed.String())
		}
	}
}

func TestValidateBaseURLRejectsNonLocalAndNonDefaultPort(t *testing.T) {
	cases := []struct {
		raw     string
		message string
	}{
		{raw: "https://127.0.0.1:41595", message: "Eagle 地址必须是 http://127.0.0.1:41595"},
		{raw: "http://127.0.0.1:41595/api", message: "Eagle 地址必须是 http://127.0.0.1:41595"},
		{raw: "http://127.0.0.1:41595?x=1", message: "Eagle 地址必须是 http://127.0.0.1:41595"},
		{raw: "http://user@127.0.0.1:41595", message: "Eagle 地址必须是 http://127.0.0.1:41595"},
		{raw: "http://10.0.0.1:41595", message: "只允许连接本机地址"},
		{raw: "http://192.168.1.8:41595", message: "只允许连接本机地址"},
		{raw: "http://127.0.0.1:8080", message: "只支持默认端口 41595"},
		{raw: "http://localhost:80", message: "只支持默认端口 41595"},
	}
	for _, tc := range cases {
		_, err := validateBaseURL(tc.raw)
		if err == nil || !strings.Contains(err.Error(), tc.message) {
			t.Fatalf("validateBaseURL(%q) error = %v, want %q", tc.raw, err, tc.message)
		}
	}
}

func TestIsMediaDataURL(t *testing.T) {
	if !isMediaDataURL("data:image/png;base64,aaaa") || !isMediaDataURL("data:video/mp4,") || !isMediaDataURL("DATA:audio/mpeg;base64,xx") {
		t.Fatal("accepted media data URLs were rejected")
	}
	if isMediaDataURL("https://example.com/a.png") || isMediaDataURL("data:text/plain,hi") || isMediaDataURL("data:") || isMediaDataURL("data:image/png") {
		t.Fatal("non-media data URLs were accepted")
	}
}

func TestValidItemID(t *testing.T) {
	if !validItemID("abc123") || !validItemID("item-1") {
		t.Fatal("plain item id rejected")
	}
	for _, id := range []string{"", " ", " abc123", "abc123 ", ".", "..", "../x", "..\\x", "a/b", `a\b`, "a?b", "a&b", "a:b", "a\nb"} {
		if validItemID(id) {
			t.Fatalf("item id %q accepted", id)
		}
	}
}
