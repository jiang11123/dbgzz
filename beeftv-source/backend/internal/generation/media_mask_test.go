package generation

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/protocol"
)

func TestImageMaskPreflightDoesNotRequireReferenceURL(t *testing.T) {
	for _, transport := range []string{"url", "link"} {
		t.Run(transport, func(t *testing.T) {
			input := Input{Mode: "image", Config: Config{InterfaceType: "openai-image", ReferenceMediaTransport: map[string]string{"image": transport}}, ReferenceImages: []Media{{URL: "https://cdn.example/source.png"}}, Mask: &Media{StorageKey: "resource:mask"}}
			if err := ValidateMediaTransport(context.Background(), input); err != nil {
				t.Fatalf("local multipart mask was blocked: %v", err)
			}
			input.ReferenceImages[0] = Media{StorageKey: "resource:source"}
			err := ValidateMediaTransport(context.Background(), input)
			var appErr *kernel.AppError
			if !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" || strings.Contains(err.Error(), "遮罩") {
				t.Fatalf("reference URL choice changed or mask was blocked: %v", err)
			}
			want := []map[string]any{{"kind": "image", "index": 0, "mask": false}}
			if !reflect.DeepEqual(appErr.Details["requiredReferences"], want) {
				t.Fatalf("requiredReferences = %#v, want %#v", appErr.Details, want)
			}
		})
	}
}

func TestImageMaskHydrationKeepsBytesAndReferenceChoice(t *testing.T) {
	registry := LoadOfficialFallbackRegistry()
	adapter, ok := registry.Resolve("openai-image")
	if !ok {
		t.Fatal("OpenAI Images plugin package must be built for the multipart regression")
	}
	for _, transport := range []string{"url", "link"} {
		for _, inline := range []bool{false, true} {
			name := transport + "/resource"
			if inline {
				name = transport + "/inline"
			}
			t.Run(name, func(t *testing.T) {
				storage := &referenceStorageFixture{}
				resources := &maskResourcesFixture{}
				ctx := WithProtocolRegistry(WithRuntime(context.Background(), Runtime{ReferenceStorage: storage, Resources: resources}), registry)
				input := Input{Mode: "image", Prompt: "edit fixture", Config: Config{InterfaceType: "openai-image", Model: "gpt-image-2.5", ReferenceMediaTransport: map[string]string{"image": transport}}, ReferenceImages: []Media{{StorageKey: "resource:one"}}, Mask: &Media{StorageKey: "resource:mask"}}
				wantUploads := 1
				if transport == "link" {
					input.ReferenceImages[0] = Media{URL: "https://cdn.example/uploaded.png"}
					wantUploads = 0
				}
				wantMask := DataURL("image/png", []byte("original mask bytes"))
				if inline {
					input.Mask = &Media{DataURL: wantMask}
				}
				if err := ValidateMediaTransport(ctx, input); err != nil {
					t.Fatal(err)
				}
				if storage.uploads != 0 || len(resources.opens) != 0 {
					t.Fatal("preflight read or uploaded bytes")
				}
				if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input)); err != nil {
					t.Fatal(err)
				}
				if storage.uploads != wantUploads || input.ReferenceImages[0].URL != "https://cdn.example/uploaded.png" || input.ReferenceImages[0].DataURL != "" {
					t.Fatalf("reference choice changed: uploads=%d media=%#v", storage.uploads, input.ReferenceImages[0])
				}
				if input.Mask.URL != "" || input.Mask.DataURL != wantMask {
					t.Fatalf("mask lost original bytes: %#v", input.Mask)
				}
				if !inline && !reflect.DeepEqual(resources.opens, []string{"mask"}) {
					t.Fatalf("unexpected byte reads: %v", resources.opens)
				}
				raw, mimeType, err := MediaBytes(*input.Mask)
				if err != nil || mimeType != "image/png" || string(raw) != "original mask bytes" {
					t.Fatalf("multipart mask bytes changed: %q %q %v", raw, mimeType, err)
				}
				spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{Request: ProtocolRequestFromInput(input)})
				if err != nil {
					t.Fatal(err)
				}
				if spec.Path != "/v1/images/edits" || spec.ContentType != "multipart/form-data" || len(spec.Files) != 2 || spec.Files[1].Name != "mask" || spec.Files[1].Reference.DataURL != wantMask || spec.Files[1].Reference.URL != "" {
					t.Fatalf("multipart mask changed: %#v", spec)
				}
			})
		}
	}
}

func TestImageMaskHydrationKeepsHostedMaskInline(t *testing.T) {
	resources := &maskResourcesFixture{hosted: true}
	ctx := WithRuntime(context.Background(), Runtime{Resources: resources})
	input := Input{Mode: "image", Config: Config{ChannelID: "managed", InterfaceType: "openai-image", ReferenceMediaTransport: map[string]string{"image": "url"}}, Mask: &Media{StorageKey: "resource:mask"}}
	if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input)); err != nil {
		t.Fatal(err)
	}
	if input.Mask.URL != "" || input.Mask.DataURL != DataURL("image/png", []byte("original mask bytes")) || resources.publicURLs != 0 {
		t.Fatalf("hosted mask became a link: %#v, URL calls=%d", input.Mask, resources.publicURLs)
	}
}

func TestMaskPolicyDoesNotExpandOtherProtocolSupport(t *testing.T) {
	for _, tc := range []struct{ mode, protocol string }{{"video", "openai-image"}, {"video", "newapi-channel-2"}, {"image", "grok-image"}} {
		input := Input{Mode: tc.mode, Config: Config{InterfaceType: tc.protocol, ReferenceMediaTransport: map[string]string{"image": "link"}}, Mask: &Media{StorageKey: "resource:mask"}}
		var appErr *kernel.AppError
		if err := ValidateMediaTransport(context.Background(), input); !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" || !strings.Contains(err.Error(), "遮罩") {
			t.Fatalf("%s/%s changed unsupported mask admission: %v", tc.mode, tc.protocol, err)
		}
		want := []map[string]any{{"kind": "image", "index": 0, "mask": true}}
		if !reflect.DeepEqual(appErr.Details["requiredReferences"], want) {
			t.Fatalf("unsupported mask repair metadata changed: %#v", appErr.Details)
		}
	}
}

type maskResourcesFixture struct {
	hosted     bool
	opens      []string
	publicURLs int
}

func (p *maskResourcesFixture) Lookup(_, id string) (ResourceInfo, error) {
	provider := "local"
	if p.hosted {
		provider = "cos"
	}
	return ResourceInfo{ID: id, Status: "ready", MimeType: "image/png", Provider: provider}, nil
}
func (p *maskResourcesFixture) Open(userID, id string) (ResourceInfo, io.ReadCloser, error) {
	p.opens = append(p.opens, id)
	info, err := p.Lookup(userID, id)
	return info, io.NopCloser(strings.NewReader("original mask bytes")), err
}
func (p *maskResourcesFixture) LocalMode() bool { return !p.hosted }
func (p *maskResourcesFixture) PublicURL(ResourceInfo, time.Time) (string, error) {
	p.publicURLs++
	return "https://cdn.example/mask.png", nil
}
func (p *maskResourcesFixture) HTTPSPublicURL(info ResourceInfo, expires time.Time) (string, error) {
	return p.PublicURL(info, expires)
}
