package assistantruntime

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Exercise the actual child environment with Node's built-in fetch and local
// CONNECT proxies. No SDK, model service, inherited credential or public target.
func TestNodeHostProxyRoutesHTTPAndHTTPSWithoutLeakingLoopbackTokens(t *testing.T) {
	node := os.Getenv("BEEFTV_TEST_NODE")
	if node == "" {
		var err error
		node, err = exec.LookPath("node")
		if err != nil {
			t.Skip("Node 24 required for proxy integration")
		}
	}
	version, err := exec.Command(node, "-p", "process.versions.node.split('.')[0]").Output()
	if err != nil || strings.TrimSpace(string(version)) != "24" {
		t.Skip("Node 24 required for proxy integration")
	}
	const targetHost = "beeftv-proxy-test.invalid"
	var localReads, proxyReads, leaked atomic.Int64
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-BeefTV-Agent-Token") == "synthetic-launch-token" {
			localReads.Add(1)
		}
		_, _ = io.WriteString(w, "local fixture")
	})
	plain := httptest.NewServer(handler)
	defer plain.Close()
	secure := httptest.NewUnstartedServer(handler)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: targetHost}, DNSNames: []string{targetHost},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	secure.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	secure.StartTLS()
	defer secure.Close()
	caFile := filepath.Join(t.TempDir(), "fixture-ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	_, plainPort, _ := net.SplitHostPort(plain.Listener.Addr().String())
	_, tlsPort, _ := net.SplitHostPort(secure.Listener.Addr().String())
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyReads.Add(1)
		if r.Header.Get("X-BeefTV-Agent-Token") != "" {
			leaked.Add(1)
		}
		if r.Method != http.MethodConnect {
			t.Error("expected Node CONNECT transport")
			http.Error(w, "CONNECT required", 400)
			return
		}
		host, port, _ := net.SplitHostPort(r.Host)
		if host != targetHost || (port != plainPort && port != tlsPort) {
			leaked.Add(1)
			http.Error(w, "unexpected target", 403)
			return
		}
		upstream, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", port))
		if err != nil {
			http.Error(w, "fixture unavailable", 502)
			return
		}
		client, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		go func() { defer upstream.Close(); defer client.Close(); _, _ = io.Copy(upstream, buffered) }()
		go func() { defer upstream.Close(); defer client.Close(); _, _ = io.Copy(client, upstream) }()
	}))
	defer proxy.Close()
	// An inherited lower-case value must not override desktopnet's upper-case
	// preference; it also detects silently keeping duplicate environment entries.
	wrong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1); http.Error(w, "wrong proxy", 502) }))
	defer wrong.Close()
	baseEnv := []string{"HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL, "http_proxy=" + wrong.URL, "https_proxy=" + wrong.URL,
		"NO_PROXY=existing.invalid", "no_proxy=wrong.invalid", "NODE_EXTRA_CA_CERTS=" + caFile}
	call := func(t *testing.T, inherited []string, target string, token bool, modelBaseURL ...string) (string, error) {
		t.Helper()
		host := New(Options{DataDir: t.TempDir(), HostToken: func() string { return "synthetic-host" }, Environ: func() []string { return inherited }})
		provider := testProvider()
		provider.BaseURL = target
		if len(modelBaseURL) > 0 {
			provider.BaseURL = modelBaseURL[0]
		}
		env := host.buildEnv(provider, testPin(plain.URL, "synthetic-launch-token"))
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, node, "--input-type=module", "-e", `try { const response = await fetch(process.argv[1], {signal: AbortSignal.timeout(2500), headers: process.argv[2] === 'true' ? {'X-BeefTV-Agent-Token': process.env.BEEFTV_AGENT_DESKTOP_TOKEN} : {}}); if (!response.ok) throw Error('http'); console.log(await response.text()); } catch(error) { console.log(error.cause?.code || error.code || error.name); process.exitCode=1; }`, target, map[bool]string{true: "true", false: "false"}[token])
		command.Env = env
		output, err := command.CombinedOutput()
		return string(output), err
	}
	for _, target := range []string{"http://" + net.JoinHostPort(targetHost, plainPort), "https://" + net.JoinHostPort(targetHost, tlsPort)} {
		t.Run(strings.Split(target, ":")[0], func(t *testing.T) {
			output, err := call(t, baseEnv, target, false)
			if err != nil || !strings.Contains(output, "local fixture") {
				t.Fatalf("proxy route failed: %v %s", err, output)
			}
		})
	}
	if proxyReads.Load() != 2 || leaked.Load() != 0 {
		t.Fatalf("proxy routes=%d unexpected=%d", proxyReads.Load(), leaked.Load())
	}
	for _, target := range []string{plain.URL, "http://localhost:" + plainPort} {
		output, err := call(t, baseEnv, target, true, "https://"+targetHost)
		if err != nil || !strings.Contains(output, "local fixture") {
			t.Fatalf("loopback route failed: %v %s", err, output)
		}
	}
	if localReads.Load() != 2 || proxyReads.Load() != 2 || leaked.Load() != 0 {
		t.Fatal("loopback credentials left the direct route")
	}
	t.Run("IPv6 ops remains direct with remote model", func(t *testing.T) {
		listener, err := net.Listen("tcp", "[::1]:0")
		if err != nil {
			t.Skip("IPv6 loopback unavailable")
		}
		ipv6 := httptest.NewUnstartedServer(handler)
		ipv6.Listener.Close()
		ipv6.Listener = listener
		ipv6.Start()
		defer ipv6.Close()
		before := proxyReads.Load()
		output, err := call(t, baseEnv, ipv6.URL, true, "https://"+targetHost)
		if err != nil || !strings.Contains(output, "local fixture") || proxyReads.Load() != before || leaked.Load() != 0 {
			t.Fatalf("IPv6 loopback was not direct: %v %s", err, output)
		}
	})
	t.Run("HTTP-only proxy does not capture HTTPS model", func(t *testing.T) {
		before := proxyReads.Load()
		output, err := call(t, []string{"HTTP_PROXY=" + proxy.URL, "NODE_EXTRA_CA_CERTS=" + caFile}, "https://"+net.JoinHostPort(targetHost, tlsPort), false)
		if err == nil || !strings.Contains(output, "ENOTFOUND") || proxyReads.Load() != before {
			t.Fatalf("HTTPS used HTTP proxy fallback: %v %s", err, output)
		}
	})
	for _, setting := range []string{"NODE_USE_ENV_PROXY=0", "NO_PROXY=*"} {
		t.Run(setting, func(t *testing.T) {
			// .invalid cannot resolve directly. A successful fixture response here
			// would prove explicit direct was incorrectly routed through the proxy.
			before := proxyReads.Load()
			_, err := call(t, append(append([]string{}, baseEnv...), setting), "http://"+net.JoinHostPort(targetHost, plainPort), false)
			if err == nil || proxyReads.Load() != before {
				t.Fatal("explicit direct used proxy")
			}
		})
	}
	t.Run("unreachable proxy never falls back to direct", func(t *testing.T) {
		dead, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		address := dead.Addr().String()
		_ = dead.Close()
		output, err := call(t, []string{"HTTP_PROXY=http://" + address}, "http://"+net.JoinHostPort(targetHost, plainPort), false)
		if err == nil || !strings.Contains(output, "ECONNREFUSED") {
			t.Fatalf("did not preserve configured proxy failure: %v %s", err, output)
		}
	})
	t.Run("malformed explicit proxy never becomes direct", func(t *testing.T) {
		output, err := call(t, []string{"HTTP_PROXY=http://[broken"}, "http://"+net.JoinHostPort(targetHost, plainPort), false)
		if err == nil || strings.Contains(output, "ENOTFOUND") {
			t.Fatalf("malformed proxy was bypassed: %v %s", err, output)
		}
	})
}

func TestModelOriginChangeRebuildsOwnedChildProxyEnvironment(t *testing.T) {
	host := fixtureHost(t, "http")
	host.opts.Environ = func() []string { return []string{fixtureEnv + "=http", "HTTP_PROXY=http://127.0.0.1:7890"} }
	original := fixtureProvider()
	original.BaseURL = "https://old-model.invalid/v1"
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	readChild := func() []string {
		raw, err := os.ReadFile(filepath.Join(host.dataDir(), "child-env.txt"))
		if err != nil {
			t.Fatal(err)
		}
		return strings.Split(string(raw), "\n")
	}
	if !strings.Contains(envValue(readChild(), "NO_PROXY"), "old-model.invalid") {
		t.Fatal("original model projection absent")
	}
	updated := original
	updated.BaseURL = "https://new-model.invalid/v1"
	if launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", false); err != nil || launched || host.PID() != first {
		t.Fatal("busy host must retain its original model and environment")
	}
	if envValue(readChild(), "BEEFTV_AGENT_BASE_URL") != original.BaseURL {
		t.Fatal("busy host changed its model")
	}
	if launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", true); err != nil || !launched || host.PID() == first {
		t.Fatal("idle model-origin change must restart the owned child")
	}
	env := readChild()
	if envValue(env, "BEEFTV_AGENT_BASE_URL") != updated.BaseURL || envValue(env, "NODE_USE_ENV_PROXY") != "1" ||
		!strings.Contains(envValue(env, "NO_PROXY"), "new-model.invalid") || strings.Contains(envValue(env, "NO_PROXY"), "old-model.invalid") {
		t.Fatal("restarted child retained stale model proxy projection")
	}
}
