// Opt-in synthetic COS probe; this program is never part of the desktop app.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/outbound"
)

type input struct {
	BaseURL string `json:"base_url"`
	Route   string `json:"route"`
	Fault   bool   `json:"fault"`
	Run     string `json:"run"`
}
type receipts struct {
	mu   sync.Mutex
	Puts []map[string]any
}

func (r *receipts) Observe(o generation.TransportObservation) {
	if o.Request == nil || o.Request.Method != "PUT" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Puts = append(r.Puts, map[string]any{"part": o.Request.URL.Query().Get("partNumber"), "route": o.TransportRoute, "status": o.StatusCode, "failed": o.Err != nil})
}
func (*receipts) NotifyPoll(context.Context, string, error) {}
func (*receipts) SyncProgress(string, []byte)               {}

type cutConn struct {
	net.Conn
	written *atomic.Int64
	cut     *atomic.Bool
}

func (c *cutConn) Write(p []byte) (int, error) {
	if c.cut.Load() {
		return c.Conn.Write(p)
	}
	const limit = (8 << 20) + (512 << 10)
	before := c.written.Add(int64(len(p))) - int64(len(p))
	if before+int64(len(p)) > limit && c.cut.CompareAndSwap(false, true) {
		remaining := int64(limit) - before
		n := 0
		if remaining > 0 {
			n, _ = c.Conn.Write(p[:remaining])
		}
		_ = c.Conn.Close()
		return n, io.ErrClosedPipe
	}
	return c.Conn.Write(p)
}

func main() {
	var in input
	if json.NewDecoder(os.Stdin).Decode(&in) != nil {
		fmt.Println(`{"ok":false,"error":"input"}`)
		os.Exit(2)
	}
	if in.Route == "direct" {
		for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
			_ = os.Setenv(k, "http://127.0.0.1:9")
		}
		_ = os.Setenv("NO_PROXY", "*")
		_ = os.Setenv("no_proxy", "*")
	}
	req, _ := http.NewRequest("PUT", "https://cos.ap-guangzhou.myqcloud.com", nil)
	proxy, proxyErr := desktopnet.Proxy(req)
	if proxyErr != nil || (in.Route == "proxy" && proxy == nil) {
		fmt.Println(`{"ok":false,"error":"required_proxy_missing"}`)
		os.Exit(2)
	}
	_ = os.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	base, _ := url.Parse(in.BaseURL)
	tr := outbound.OutboundHTTPClient(0).Transport.(*http.Transport)
	var written atomic.Int64
	var cut atomic.Bool
	original := tr.DialContext
	if in.Fault {
		tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := original(ctx, network, address)
			if err != nil {
				return nil, err
			}
			if address == base.Host {
				return conn, nil
			}
			return &cutConn{Conn: conn, written: &written, cut: &cut}, nil
		}
	}
	var b bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 800, 800))
	img.Set(0, 0, color.RGBA{R: 128, A: 255})
	_ = png.Encode(&b, img)
	data := append(b.Bytes(), make([]byte, 17<<20)...)
	data = append(data, []byte(in.Run+in.Route+fmt.Sprint(in.Fault))...)
	sum := sha256.Sum256(data)
	expected := hex.EncodeToString(sum[:])
	rec := &receipts{}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	ctx = generation.WithRuntime(ctx, generation.Runtime{Endpoints: generation.Endpoints{BeefAPIVideoBaseURL: in.BaseURL}, Receipts: rec})
	config := generation.Config{BaseURL: in.BaseURL + "/v1", APIKey: "cos-live-fixture", InterfaceType: "newapi", Model: "seedance-2.0-mini"}
	task := generation.Input{Config: config, ReferenceImages: []generation.Media{{DataURL: "fixture", MimeType: "image/png"}}}
	start := time.Now()
	err := generation.PrepareBeefAPIVideoReferences(ctx, config, &task, func(string, generation.Media) ([]byte, string, bool, error) { return data, "image/png", false, nil })
	out := map[string]any{"event": "cos_live_client", "route": in.Route, "fault": in.Fault, "proxy_selected": proxy != nil, "cut_triggered": cut.Load(), "bytes": len(data), "sha256": expected, "seconds": time.Since(start).Seconds(), "puts": rec.Puts}
	if err != nil {
		failure := generation.ClassifyError(err)
		out["ok"] = false
		out["error_type"] = fmt.Sprintf("%T", err)
		out["http"] = failure.HTTPStatus
		out["category"] = failure.Category
	} else {
		downloaded, _, downloadErr := generation.GetExternalBinary(ctx, task.ReferenceImages[0].URL)
		got := sha256.Sum256(downloaded)
		out["download_ok"] = downloadErr == nil
		out["hash_match"] = bytes.Equal(got[:], sum[:])
		out["download_bytes"] = len(downloaded)
		out["ok"] = downloadErr == nil && bytes.Equal(got[:], sum[:]) && (!in.Fault || cut.Load())
	}
	raw, _ := json.Marshal(out)
	fmt.Println(strings.TrimSpace(string(raw)))
	if out["ok"] != true {
		os.Exit(1)
	}
}
