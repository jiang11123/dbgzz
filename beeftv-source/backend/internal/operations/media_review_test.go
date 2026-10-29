package operations

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

type reviewDomain struct {
	*mediaDomain
	calls int
	part  MediaPart
}

func (d *reviewDomain) ReviewMedia(_ context.Context, p MediaPart, q string) (MediaReviewObservation, error) {
	d.calls++
	d.part = p
	return MediaReviewObservation{Model: "fixture", RequestID: "request", Text: q}, nil
}

func TestMediaReviewUsesOwnedVersionedClipAndDoesNotExposeBytes(t *testing.T) {
	data := nativeMediaFixture(t, true, false)
	sum := sha256.Sum256(data)
	d := &reviewDomain{mediaDomain: &mediaDomain{owner: "owner", data: data}}
	ctx := &Context{Context: context.Background(), UserID: "owner", Domain: d}
	args := mediaReviewArgs{CanvasID: "canvas", NodeID: "node", ExpectedVersion: hex.EncodeToString(sum[:]), StartMs: 200, EndMs: 1200, Question: "观察动作和声音"}
	call := func(a mediaReviewArgs) (any, error) { b, _ := json.Marshal(a); return runMediaReview(ctx, b) }
	result, err := call(args)
	if err != nil {
		t.Fatal(err)
	}
	if d.calls != 1 || d.part.Source.StartMs != 200 || d.part.Source.EndMs != 1200 || d.part.MimeType != "video/mp4" {
		t.Fatalf("wrong bounded source: %+v", d.part.Source)
	}
	bytes, err := base64.StdEncoding.DecodeString(d.part.Data)
	if err != nil || len(bytes) == 0 {
		t.Fatal("missing actual media")
	}
	hash := sha256.Sum256(bytes)
	if hex.EncodeToString(hash[:]) != d.part.SHA256 {
		t.Fatal("wrong wire hash")
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), d.part.Data) {
		t.Fatal("native bytes leaked into model observation")
	}
	for _, change := range []func(*mediaReviewArgs){func(a *mediaReviewArgs) { a.CanvasID = "foreign" }, func(a *mediaReviewArgs) { a.ExpectedVersion = "stale" }, func(a *mediaReviewArgs) { a.EndMs = 20000 }, func(a *mediaReviewArgs) { a.Question = "" }} {
		bad := args
		change(&bad)
		if _, err := call(bad); err == nil {
			t.Fatal("invalid review accepted")
		}
		if d.calls != 1 {
			t.Fatal("invalid reference incurred inference")
		}
	}
	r := NewRegistry(nil, nil)
	registerMediaOps(r)
	desc, _ := r.Descriptor("media.review")
	if !desc.ReadOnly || desc.Replay != "unsafe" {
		t.Fatal("paid read must not replay automatically")
	}
}

func TestMediaReviewDiscoversOptionalResourceID(t *testing.T) {
	r := NewRegistry(nil, nil)
	registerMediaOps(r)
	desc, _ := r.Descriptor("media.review")
	var schema struct {
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(desc.Params, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Properties["resourceId"].Type != "string" || slices.Contains(schema.Required, "resourceId") {
		t.Fatal("review discovery must accept resourceId without requiring it for single-resource targets")
	}
}

func TestMediaReviewSelectsReferencedResourceBeforeInference(t *testing.T) {
	data := nativeMediaFixture(t, true, false)
	sum := sha256.Sum256(data)
	for _, target := range []string{"nodeId", "assetId"} {
		for _, mode := range []string{"video", "audio"} {
			for _, test := range []struct {
				name, resourceID, reason string
			}{
				{"selected", "resource", ""},
				{"missing", "", "media_resource_required"},
				{"unreferenced", "unreferenced", "media_not_referenced"},
				{"referenced-but-unowned", "other", "foreign_resource"},
			} {
				t.Run(target+"/"+mode+"/"+test.name, func(t *testing.T) {
					d := &reviewDomain{mediaDomain: &mediaDomain{owner: "owner", data: data,
						document:     json.RawMessage(`{"nodes":[{"id":"node","metadata":{"resourceId":"resource","poster":{"resourceId":"other"}}}]}`),
						assetPayload: `{"resourceId":"resource","poster":{"resourceId":"other"}}`,
					}}
					args := map[string]any{"canvasId": "canvas", "expectedVersion": hex.EncodeToString(sum[:]),
						"startMs": 200, "endMs": 1200, "mode": mode, "question": "观察片段"}
					args[target] = map[string]string{"nodeId": "node", "assetId": "asset"}[target]
					if test.resourceID != "" {
						args["resourceId"] = test.resourceID
					}
					raw, _ := json.Marshal(args)
					result, err := runMediaReview(&Context{Context: context.Background(), UserID: "owner", Domain: d}, raw)
					if test.reason != "" {
						if err == nil || AsError(err).Reason != test.reason || result != nil {
							t.Fatalf("expected %s, got result=%+v error=%v", test.reason, result, err)
						}
						if d.calls != 0 || d.opens != 0 {
							t.Fatalf("rejected resource reached media read/inference: opens=%d calls=%d", d.opens, d.calls)
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					mime := map[string]string{"video": "video/mp4", "audio": "audio/wav"}[mode]
					if d.calls != 1 || d.opens != 1 || d.part.Source.ResourceID != "resource" || d.part.MimeType != mime {
						t.Fatalf("selected resource did not reach one review: opens=%d calls=%d source=%+v mime=%s", d.opens, d.calls, d.part.Source, d.part.MimeType)
					}
					if source := result.(map[string]any)["source"].(MediaSource); source != d.part.Source {
						t.Fatalf("review receipt lost selected source: %+v", source)
					}
				})
			}
		}
	}
}
