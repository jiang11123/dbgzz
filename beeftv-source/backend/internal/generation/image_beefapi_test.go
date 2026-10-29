package generation

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/providerpreset"
)

type captureImagePort struct {
	calls             int
	path, contentType string
	body              map[string]interface{}
}

func (p *captureImagePort) Intercept(req *http.Request) (bool, []byte, string, error) {
	p.calls++
	p.path, p.contentType = req.URL.Path, req.Header.Get("Content-Type")
	if err := json.NewDecoder(req.Body).Decode(&p.body); err != nil {
		return true, nil, "", err
	}
	return true, []byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}]}`), "application/json", nil
}

func TestBeefAPIHyImageUsesGenerationJSONForReferences(t *testing.T) {
	for _, count := range []int{0, 1, 3} {
		port := &captureImagePort{}
		ctx := WithRuntime(context.Background(), Runtime{Images: port})
		input := Input{Mode: "image", Prompt: "画一只小猫", Config: Config{BaseURL: "https://beeftv.app", APIKey: "synthetic", Model: "hy-image-v3", InterfaceType: "chat-completion", Size: "16:9"}}
		for i := 0; i < count; i++ {
			input.ReferenceImages = append(input.ReferenceImages, Media{DataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="})
		}
		result, err := RunImageTask(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if port.calls != 1 || port.path != "/v1/images/generations" || port.contentType != "application/json" || port.body["size"] != "1280x720" || result["mode"] != "image" {
			t.Fatalf("wire = %#v, result=%#v", port, result)
		}
		if count > 0 && len(port.body["images"].([]interface{})) != count {
			t.Fatalf("references = %#v", port.body)
		}
		for _, key := range []string{"n", "quality", "response_format", "output_format", "background", "mask", "image"} {
			if _, exists := port.body[key]; exists {
				t.Fatalf("unexpected field %s", key)
			}
		}
	}
}

func TestExecuteRepairsOldHyImageProtocolForBothBaseURLs(t *testing.T) {
	for _, base := range []string{"https://beeftv.app", "https://beeftv.app/v1", "https://enterprise.beefapi.com/v1"} {
		port := &captureImagePort{}
		ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Images = port }))
		_, err := Execute(ctx, Input{Mode: "image", Prompt: "test", Config: Config{BaseURL: base, APIKey: "synthetic", Model: "hy-image-v3", InterfaceType: "chat-completion", Size: "1:1"}})
		if err != nil || port.path != "/v1/images/generations" {
			t.Fatalf("%s: path=%s err=%v", base, port.path, err)
		}
	}
}

func TestBeefAPIHyImageRejectsUnsupportedInputBeforeSubmit(t *testing.T) {
	for _, change := range []func(*Input){
		func(i *Input) { i.Config.Size = "2048x2048" },
		func(i *Input) { i.Config.Size = "2k" },
		func(i *Input) { i.Mask = &Media{} },
		func(i *Input) { i.Config.TransparentBackground = "true" },
		func(i *Input) { i.Config.Quality = "high" },
		func(i *Input) { i.Prompt = strings.Repeat("字", 8193) },
		func(i *Input) { i.ReferenceImages = make([]Media, 4) },
		func(i *Input) { i.ReferenceImages = []Media{{DataURL: "data:image/png;base64,bm90LWFuLWltYWdl"}} },
	} {
		port := &captureImagePort{}
		input := Input{Mode: "image", Prompt: "test", Config: Config{BaseURL: "https://beeftv.app", Model: "hy-image-v3", Size: "1:1"}}
		change(&input)
		_, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input)
		if err == nil || port.calls != 0 {
			t.Fatalf("invalid input dispatched: calls=%d, err=%v", port.calls, err)
		}
	}
}

func TestBeefAPIHyImageRatioSizesMeetGatewayLimits(t *testing.T) {
	contract, _ := providerpreset.BeefAPIImageContract("hy-image-v3")
	for ratio, want := range contract.Sizes {
		if size, err := contract.PixelSize(ratio); err != nil || size != want {
			t.Fatalf("%s: size=%s err=%v", ratio, size, err)
		}
	}
}
