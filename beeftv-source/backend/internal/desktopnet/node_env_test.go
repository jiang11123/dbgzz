package desktopnet

import (
	"strings"
	"testing"
)

func TestNodeProxyEnvironmentProjectsExistingDesktopSelection(t *testing.T) {
	windows := parseWindowsProxy("http=127.0.0.1:8080;https=127.0.0.1:7890", "*.internal;<local>")
	mac := parseMacProxy("HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 8080\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\nExcludeSimpleHostnames : 1")
	for _, system := range []systemProxySettings{windows, mac} {
		for _, tc := range []struct {
			name                              string
			env                               []string
			target, http, https, bypass, flag string
		}{
			{"system only", nil, "https://remote.invalid/v1", "http://127.0.0.1:8080", "http://127.0.0.1:7890", "", "1"},
			{"launcher empty", []string{"HTTP_PROXY=", "HTTPS_PROXY="}, "https://remote.invalid", "http://127.0.0.1:8080", "http://127.0.0.1:7890", "", "1"},
			{"local model", nil, "http://intranet:8000/v1", "http://127.0.0.1:8080", "http://127.0.0.1:7890", "intranet", "1"},
			{"CIDR model", []string{"HTTPS_PROXY=http://explicit:1234", "NO_PROXY=10.0.0.0/8"}, "https://10.20.30.40/v1", "", "http://explicit:1234", "10.20.30.40", "1"},
			{"HTTP only HTTPS model", []string{"HTTP_PROXY=http://explicit:1234"}, "https://remote.invalid/v1", "http://explicit:1234", "", "remote.invalid", "1"},
			{"explicit disable", []string{"NODE_USE_ENV_PROXY=0"}, "https://remote.invalid", "http://127.0.0.1:8080", "http://127.0.0.1:7890", "", "0"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				out := nodeProxyEnvironment(tc.env, tc.target, func() systemProxySettings { return system })
				values := nodeEnvMap(t, out)
				if values["HTTP_PROXY"] != tc.http || values["HTTPS_PROXY"] != tc.https || values["NODE_USE_ENV_PROXY"] != tc.flag {
					t.Fatal("desktop proxy selection changed")
				}
				for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"} {
					if values[name] != values[strings.ToLower(name)] {
						t.Fatal("Node/Go environment precedence differs")
					}
				}
				for _, host := range []string{"localhost", "127.0.0.1", "[::1]", tc.bypass} {
					if host != "" && !strings.Contains(","+values["NO_PROXY"]+",", ","+host+",") {
						t.Fatalf("missing direct target %s", host)
					}
				}
			})
		}
	}
}

func TestNodeProxyEnvironmentPreservesExplicitSelectionAndWildcard(t *testing.T) {
	for _, bypass := range []string{"*", "other.invalid, *", "*.internal"} {
		input := []string{"PATH=/fixture", "HTTP_PROXY=http://old:1", "HTTP_PROXY=http://upper:2", "http_proxy=http://lower:3", "HTTPS_PROXY=http://upper:4", "https_proxy=http://lower:5", "NO_PROXY=" + bypass, "no_proxy=wrong.invalid", "ALL_PROXY=http://wrong:6"}
		out := nodeProxyEnvironment(input, "https://remote.invalid", func() systemProxySettings {
			t.Fatal("explicit environment must not read system proxy")
			return systemProxySettings{}
		})
		values := nodeEnvMap(t, out)
		if values["PATH"] != "/fixture" || values["HTTP_PROXY"] != "http://upper:2" || values["HTTPS_PROXY"] != "http://upper:4" || values["ALL_PROXY"] != "" {
			t.Fatal("inherited precedence changed")
		}
		if bypass != "*.internal" && values["NO_PROXY"] != "*" {
			t.Fatal("Node wildcard must remain the entire value")
		}
	}
	values := nodeEnvMap(t, nodeProxyEnvironment([]string{"HTTPS_PROXY=http://[broken"}, "https://remote.invalid", func() systemProxySettings {
		t.Fatal("bad explicit proxy must not fall back to system")
		return systemProxySettings{}
	}))
	if strings.Contains(values["NO_PROXY"], "remote.invalid") || values["HTTPS_PROXY"] != "http://[broken" {
		t.Fatal("invalid explicit proxy silently became direct")
	}
}

func nodeEnvMap(t *testing.T, env []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		if _, exists := out[key]; exists {
			t.Fatalf("duplicate environment key %s", key)
		}
		out[key] = value
	}
	return out
}
