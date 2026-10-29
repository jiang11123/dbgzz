package generation

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

type imageReplayProbeTransport func(*http.Request) (*http.Response, error)

func (f imageReplayProbeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestImageReplayMetadataFailureStopsBeforePaidPost(t *testing.T) {
	req, _ := http.NewRequest("POST", "https://8.8.8.8/v1/images/generations", nil)
	calls := 0
	client := &http.Client{Transport: imageReplayProbeTransport(func(probe *http.Request) (*http.Response, error) {
		calls++
		if probe.Method != "GET" {
			t.Fatal("paid request dispatched after metadata failure")
		}
		return nil, context.DeadlineExceeded
	})}
	got, err := negotiateImageReplay(req, client)
	if got != nil || !errors.Is(err, context.DeadlineExceeded) || calls != 3 {
		t.Fatalf("probe failure allowed submission: %v %v %d", got, err, calls)
	}
}

func TestImageReplayNegotiatesProtocolWithoutHostList(t *testing.T) {
	for _, version := range []string{ImageReplayProtocol, "", "unknown-version"} {
		t.Run(version, func(t *testing.T) {
			req, _ := http.NewRequest("POST", "https://8.8.8.8/custom/v1/images/edits", strings.NewReader("image body"))
			req.Header.Set("Authorization", "Bearer fixture")
			req.Header.Set("Idempotency-Key", "original-key")
			calls := 0
			client := &http.Client{Transport: imageReplayProbeTransport(func(probe *http.Request) (*http.Response, error) {
				calls++
				if probe.Method != "GET" || probe.URL.String() != "https://8.8.8.8/custom/v1/models" || probe.Header.Get("Idempotency-Key") != "" || probe.Header.Get("Authorization") != "Bearer fixture" {
					t.Fatal("invalid metadata probe")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"X-Image-Submission-Protocol": []string{version}}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: probe}, nil
			})}
			negotiated, err := negotiateImageReplay(req, client)
			if err != nil || calls != 1 || RecoverableImageEndpoint(negotiated) != (version == ImageReplayProtocol) {
				t.Fatalf("negotiation: calls=%d err=%v", calls, err)
			}
			if req.Header.Get("Idempotency-Key") != "original-key" || RecoverableImageEndpoint(req) {
				t.Fatal("probe changed original request")
			}
		})
	}
}

func TestImageReplayMetadataRedirectNeverReceivesCredential(t *testing.T) {
	req, _ := http.NewRequest("POST", "https://8.8.8.8/v1/images/generations", nil)
	req.Header.Set("Authorization", "Bearer fixture")
	calls := 0
	client := &http.Client{Transport: imageReplayProbeTransport(func(probe *http.Request) (*http.Response, error) {
		calls++
		if calls > 1 {
			t.Fatal("credentialed metadata followed redirect")
		}
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://1.1.1.1/models"}}, Body: io.NopCloser(strings.NewReader("")), Request: probe}, nil
	})}
	got, err := negotiateImageReplay(req, client)
	if err != nil || calls != 1 || RecoverableImageEndpoint(got) {
		t.Fatalf("redirect negotiation: %v", err)
	}
}

func TestProtocolImageURLIsSavedBeforeAnyDownload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	gets := 0
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { gets++ }))
	defer srv.Close()
	url := srv.URL + "/original.png"
	result, err := FinishProtocolResult(context.Background(), Config{}, "image", "original", &protocol.Result{Images: []protocol.MediaReference{{URL: url, Kind: "image"}}}, DefaultVideoPollPolicy())
	if err != nil || gets != 0 {
		t.Fatalf("image result downloaded before durable delivery: gets=%d err=%v", gets, err)
	}
	items := result["images"].([]interface{})
	if items[0].(map[string]interface{})["url"] != url {
		t.Fatalf("original image identity lost: %#v", result)
	}
}

func TestImageReplayTransientMetadataFailureRecoversBeforePaidPost(t *testing.T) {
	req, _ := http.NewRequest("POST", "https://8.8.8.8/v1/images/generations", nil)
	calls := 0
	client := &http.Client{Transport: imageReplayProbeTransport(func(probe *http.Request) (*http.Response, error) {
		calls++
		if probe.Method != "GET" {
			t.Fatal("metadata retry dispatched paid POST")
		}
		if calls == 1 {
			return nil, context.DeadlineExceeded
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"X-Image-Submission-Protocol": []string{ImageReplayProtocol}}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: probe}, nil
	})}
	got, err := negotiateImageReplay(req, client)
	if err != nil || calls != 2 || !RecoverableImageEndpoint(got) {
		t.Fatalf("metadata recovery: calls=%d err=%v", calls, err)
	}
}

func TestImageReplayProbeFailureProvesNoSubmission(t *testing.T) {
	req, _ := http.NewRequest("POST", "https://8.8.8.8/v1/images/generations", nil)
	client := &http.Client{Transport: imageReplayProbeTransport(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })}
	_, err := negotiateImageReplay(req, client)
	var preparation RequestPreparationError
	failure := ClassifyError(err)
	if !errors.As(err, &preparation) || !SafeRouteRejection(err) || failure.Uncertain || failure.Category != CategoryRequestNotSent {
		t.Fatalf("preflight misclassified: %#v %v", failure, err)
	}
}
