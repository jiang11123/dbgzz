package desktopnet

import (
	"net/url"
	"runtime"
	"strings"

	"golang.org/x/net/http/httpproxy"
)

// NodeProxyEnvironment enables Node's public environment proxy support for a
// fixed model origin. System parsing and target selection stay with desktopnet.
// Return a replacement environment: duplicate/case-conflicting inherited keys
// otherwise have different precedence in Go, Node and Windows launchers.
func NodeProxyEnvironment(inherited []string, modelBaseURL string) []string {
	return nodeProxyEnvironment(inherited, modelBaseURL, readSystemProxy)
}

func nodeProxyEnvironment(inherited []string, modelBaseURL string, systemReader func() systemProxySettings) []string {
	values := map[string]string{}
	for _, entry := range inherited {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	get := func(upper, lower string) string {
		if value := values[upper]; value != "" {
			return value
		}
		if value := values[lower]; value != "" {
			return value
		}
		// Windows environment names are case insensitive, including launcher-
		// supplied mixed-case names. Unix retains httpproxy's exact-name rules.
		if runtime.GOOS == "windows" {
			for i := len(inherited) - 1; i >= 0; i-- {
				key, value, _ := strings.Cut(inherited[i], "=")
				if strings.EqualFold(key, upper) {
					return value
				}
			}
		}
		return ""
	}
	config := httpproxy.Config{HTTPProxy: get("HTTP_PROXY", "http_proxy"), HTTPSProxy: get("HTTPS_PROXY", "https_proxy"), NoProxy: get("NO_PROXY", "no_proxy"), CGI: values["REQUEST_METHOD"] != ""}
	explicit := strings.TrimSpace(config.HTTPProxy) != "" || strings.TrimSpace(config.HTTPSProxy) != ""
	system := systemProxySettings{}
	if !explicit {
		system = systemReader()
	}
	resolved := config
	if !explicit {
		resolved.HTTPProxy, resolved.HTTPSProxy = system.config.HTTPProxy, system.config.HTTPSProxy
		resolved.NoProxy = strings.Trim(config.NoProxy+","+system.config.NoProxy, ",")
	}
	// Node requires a URL; Windows static proxy settings can be host:port.
	// Keep malformed explicit values as failures, never turn them into bypasses.
	valid := true
	normalize := func(raw string) string {
		if raw == "" {
			return ""
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			valid = false
		}
		return raw
	}
	resolved.HTTPProxy, resolved.HTTPSProxy = normalize(resolved.HTTPProxy), normalize(resolved.HTTPSProxy)
	bypass := []string{resolved.NoProxy, "localhost", "127.0.0.1", "::1", "[::1]"}
	if target, err := url.Parse(modelBaseURL); err == nil && target.Hostname() != "" && valid {
		var selected *url.URL
		if explicit {
			selected, err = config.ProxyFunc()(target)
		} else {
			selected, err = proxyWithSystem(target, config, system)
		}
		// Node fetch lacks Go's CIDR/<local> matching and uses HTTP_PROXY for
		// HTTPS when HTTPS_PROXY is absent. Project Go's decision for this origin.
		if err == nil && selected == nil {
			bypass = append(bypass, target.Hostname())
			if strings.Contains(target.Hostname(), ":") {
				bypass = append(bypass, "["+target.Hostname()+"]")
			}
		}
	}
	noProxy := strings.Trim(strings.Join(bypass, ","), ",")
	for _, item := range strings.Split(resolved.NoProxy, ",") {
		if strings.TrimSpace(item) == "*" {
			noProxy = "*"
			break
		}
	}
	useProxy := get("NODE_USE_ENV_PROXY", "NODE_USE_ENV_PROXY")
	if useProxy == "" {
		useProxy = "1"
	}
	keys := map[string]bool{"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true, "NODE_USE_ENV_PROXY": true}
	out := make([]string, 0, len(inherited)+9)
	for _, entry := range inherited {
		key, _, _ := strings.Cut(entry, "=")
		if !keys[strings.ToUpper(key)] {
			out = append(out, entry)
		}
	}
	return append(out, "HTTP_PROXY="+resolved.HTTPProxy, "http_proxy="+resolved.HTTPProxy,
		"HTTPS_PROXY="+resolved.HTTPSProxy, "https_proxy="+resolved.HTTPSProxy,
		"NO_PROXY="+noProxy, "no_proxy="+noProxy, "ALL_PROXY=", "all_proxy=", "NODE_USE_ENV_PROXY="+useProxy)
}
