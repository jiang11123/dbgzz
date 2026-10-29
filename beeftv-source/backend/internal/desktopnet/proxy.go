package desktopnet

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"golang.org/x/net/http/httpproxy"
)

type systemProxySettings struct {
	config        httpproxy.Config
	excludeSimple bool
	autoConfig    bool
}

// ConfigurationStatus returns no proxy addresses, bypass hosts or credentials.
func ConfigurationStatus() struct {
	Mode           string
	AutoConfigOnly bool
} {
	status := struct {
		Mode           string
		AutoConfigOnly bool
	}{Mode: "direct"}
	if ExplicitProxyConfigured() {
		status.Mode = "environment"
		return status
	}
	system := readSystemProxy()
	if system.config.HTTPProxy != "" || system.config.HTTPSProxy != "" {
		status.Mode = "system"
	} else {
		status.AutoConfigOnly = system.autoConfig
	}
	return status
}

// Desktop launchers do not inherit shell proxy variables. Read system settings
// on each request so retry also works after the user changes their proxy.
func Proxy(req *http.Request) (*url.URL, error) {
	config := httpproxy.FromEnvironment()
	if ExplicitProxyConfigured() {
		return config.ProxyFunc()(req.URL)
	}
	return proxyWithSystem(req.URL, *config, readSystemProxy())
}

// A local/private proxy is trusted as a user-selected egress, never as a
// target URL exemption. Outbound callers must still validate target addresses.
func ConfiguredProxyAddress(address string) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	config := *httpproxy.FromEnvironment()
	if !ExplicitProxyConfigured() {
		config = readSystemProxy().config
	}
	for _, raw := range []string{config.HTTPProxy, config.HTTPSProxy} {
		if raw == "" {
			continue
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		proxyPort := u.Port()
		if proxyPort == "" {
			switch u.Scheme {
			case "https":
				proxyPort = "443"
			case "socks5", "socks5h":
				proxyPort = "1080"
			default:
				proxyPort = "80"
			}
		}
		if port == proxyPort && strings.EqualFold(strings.Trim(u.Hostname(), "[]."), strings.Trim(host, "[].")) {
			return true
		}
	}
	return false
}

// HTTPSProxyEnvironment carries desktop proxy selection to HTTPS-only child
// downloaders, including redirect hosts and the system bypass list.
func HTTPSProxyEnvironment() []string {
	config := httpproxy.FromEnvironment()
	if !ExplicitProxyConfigured() {
		system := readSystemProxy()
		config.HTTPSProxy = system.config.HTTPSProxy
		config.NoProxy = strings.Trim(config.NoProxy+","+system.config.NoProxy, ",")
	}
	bypass := strings.Split(config.NoProxy, ",")
	for i, host := range bypass {
		bypass[i] = strings.TrimSpace(host)
		if strings.HasPrefix(bypass[i], "*.") {
			bypass[i] = bypass[i][1:]
		}
	}
	noProxy := strings.Join(bypass, ",")
	return []string{"HTTPS_PROXY=" + config.HTTPSProxy, "https_proxy=" + config.HTTPSProxy, "NO_PROXY=" + noProxy, "no_proxy=" + noProxy, "ALL_PROXY=", "all_proxy="}
}

// Explicit environment configuration must never be bypassed automatically.
func ExplicitProxyConfigured() bool {
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return true
		}
	}
	return false
}

func proxyWithSystem(target *url.URL, env httpproxy.Config, system systemProxySettings) (*url.URL, error) {
	if system.excludeSimple && !strings.Contains(target.Hostname(), ".") && net.ParseIP(target.Hostname()) == nil {
		return nil, nil
	}
	env.HTTPProxy = system.config.HTTPProxy
	env.HTTPSProxy = system.config.HTTPSProxy
	env.NoProxy = strings.Trim(env.NoProxy+","+system.config.NoProxy, ",")
	return env.ProxyFunc()(target)
}

func parseWindowsProxy(server, bypass string) systemProxySettings {
	settings := systemProxySettings{excludeSimple: strings.Contains(strings.ToLower(bypass), "<local>")}
	settings.config.NoProxy = strings.ReplaceAll(strings.ReplaceAll(bypass, "<local>", ""), ";", ",")
	if !strings.Contains(server, "=") {
		settings.config.HTTPProxy = strings.TrimSpace(server)
		settings.config.HTTPSProxy = strings.TrimSpace(server)
		return settings
	}
	for _, part := range strings.Split(server, ";") {
		protocol, address, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch strings.ToLower(protocol) {
		case "http":
			settings.config.HTTPProxy = strings.TrimSpace(address)
		case "https":
			settings.config.HTTPSProxy = strings.TrimSpace(address)
		}
	}
	return settings
}

func parseMacProxy(output string) systemProxySettings {
	values := map[string]string{}
	var bypass []string
	inExceptions := false
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ExceptionsList :") {
			inExceptions = true
			continue
		}
		if line == "}" {
			inExceptions = false
			continue
		}
		key, value, ok := strings.Cut(line, " : ")
		if !ok {
			continue
		}
		if inExceptions {
			bypass = append(bypass, value)
		} else {
			values[key] = value
		}
	}
	address := func(protocol string) string {
		if values[protocol+"Enable"] != "1" {
			return ""
		}
		host, port := values[protocol+"Proxy"], values[protocol+"Port"]
		n, err := strconv.Atoi(port)
		if host == "" || err != nil || n < 1 || n > 65535 {
			return ""
		}
		return "http://" + net.JoinHostPort(host, port)
	}
	return systemProxySettings{
		config:        httpproxy.Config{HTTPProxy: address("HTTP"), HTTPSProxy: address("HTTPS"), NoProxy: strings.Join(bypass, ",")},
		excludeSimple: values["ExcludeSimpleHostnames"] == "1",
		autoConfig:    values["ProxyAutoConfigEnable"] == "1" || values["ProxyAutoDiscoveryEnable"] == "1",
	}
}
