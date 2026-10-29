package depthruntime

import (
	"net/http"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
)

var downloadClient = newDownloadClient()

func newDownloadClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = desktopnet.Proxy
	transport.TLSHandshakeTimeout = 15 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{Transport: transport}
}
